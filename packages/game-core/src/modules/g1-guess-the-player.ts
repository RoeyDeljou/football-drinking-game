/**
 * G1 — Guess the Player (general, `simultaneous-answer`)
 *
 * A **deduction** game, deliberately not a flat multiple-choice question (that is G6 Trivia Rush).
 * Clues about one mystery footballer unlock one at a time; the option list is fixed from the start,
 * and each new clue should rule out more of the options. Guess early and you keep more of the base
 * points; every extra clue costs `cluePenalty`.
 *
 * Clue ladder (varied per round, see `orderClues`):
 *  - **Profile tier** — nationality, position, age — in a per-round shuffled order, so rounds do not
 *    all open on the same clue type. The opening clue is chosen from this tier only.
 *  - **Give-away tier** — club history and shirt number — always last (shuffled between themselves):
 *    once you have seen a player's clubs the round is effectively over, so they must not open it.
 *
 * Options are an *elimination puzzle* built against that ladder (see `selectDistractors`): at most
 * a third of the distractors survive the opening clue, the rest are spread across different values
 * of it, and every distractor is contradicted by at least one clue — so the set is fair at every
 * stage and always solvable by the last clue.
 *
 * Clue unlocking is derived from the injected clock rather than stored, so it needs no extra
 * action, replays identically, and `projectRound` can never emit a clue the player has not earned.
 * Because the stored state does not change when a clue unlocks, the module declares
 * `nextContentChangeAt`; the engine's `TICK` then commits a new state at each unlock so the
 * transport rebroadcasts the new clue to everyone (previously clues only appeared when some
 * unrelated action — a submission — happened to trigger a broadcast).
 * All randomness goes through `ctx.rng`, so the same RNG state always produces the same round.
 */

import type { PlayerProfile } from '@fdg/football-data';
import { z } from 'zod';
import { asGameModuleId } from '../ids.js';
import { defineGameModule } from '../module.js';
import type { PenaltyEvent } from '../penalties.js';
import { penalty } from '../penalties.js';
import type { Rng } from '../ports.js';
import { pickRoundWinners } from '../scoring.js';
import {
  footballPlayerIdSchema,
  nonSubmitters,
  positionSchema,
  rolledSelfPenalties,
  scoreChoiceRound,
} from './helpers.js';

export const G1_ID = asGameModuleId('G1');

const clueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('NATIONALITY'), value: z.string() }).strict(),
  z.object({ kind: z.literal('POSITION'), value: positionSchema }).strict(),
  z.object({ kind: z.literal('AGE'), value: z.number().int() }).strict(),
  z.object({ kind: z.literal('CAREER'), clubs: z.array(z.string()).min(1) }).strict(),
  z.object({ kind: z.literal('SHIRT_NUMBER'), value: z.number().int() }).strict(),
]);

export type G1Clue = z.infer<typeof clueSchema>;

const optionSchema = z.object({ playerId: footballPlayerIdSchema, name: z.string() }).strict();

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(5_000).max(300_000),
    clueIntervalMs: z.number().int().min(1_000).max(60_000),
    optionCount: z.number().int().min(2).max(12),
    /** Fraction of the base lost per extra clue revealed. */
    cluePenalty: z.number().min(0).max(0.5),
    minCredit: z.number().min(0).max(1),
    /** On/off switch: `0` disables the penalty, any positive value enables a drink roll. */
    wrongAnswerSips: z.number().int().min(0).max(10),
    /** On/off switch: `0` disables the penalty, any positive value enables a drink roll. */
    noAnswerSips: z.number().int().min(0).max(10),
    /** Sips everyone else owes when somebody solves it on the first clue. */
    firstClueBonusSips: z.number().int().min(0).max(10),
  })
  .strict();

const publicPayloadSchema = z
  .object({
    kind: z.literal('GUESS_PLAYER'),
    clues: z.array(clueSchema).min(1),
    options: z.array(optionSchema).min(2),
    clueIntervalMs: z.number().int(),
  })
  .strict();

const solutionSchema = z
  .object({ playerId: footballPlayerIdSchema, name: z.string(), clueCount: z.number().int() })
  .strict();

const submissionSchema = z.object({ playerId: footballPlayerIdSchema }).strict();

interface G1Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const G1_DEFAULT_CONFIG: G1Shape['config'] = {
  answerWindowMs: 45_000,
  clueIntervalMs: 8_000,
  optionCount: 4,
  cluePenalty: 0.15,
  minCredit: 0.25,
  wrongAnswerSips: 2,
  noAnswerSips: 3,
  firstClueBonusSips: 1,
};

/** Clues unlocked after `elapsedMs`: one immediately, then one per interval. */
export const visibleClueCount = (elapsedMs: number, clueIntervalMs: number, totalClues: number): number => {
  if (totalClues <= 0) return 0;
  const unlocked = 1 + Math.floor(Math.max(0, elapsedMs) / Math.max(1, clueIntervalMs));
  return Math.min(totalClues, Math.max(1, unlocked));
};

/**
 * When the next clue unlocks — the instant `projectRound` starts showing one more clue — or `null`
 * once every clue is visible. Mirrors `visibleClueCount` exactly, so the engine's rebroadcast
 * schedule and the projection can never disagree about when a clue appears.
 */
export const nextClueUnlockAt = (
  now: number,
  startedAt: number,
  clueIntervalMs: number,
  totalClues: number,
): number | null => {
  const visible = visibleClueCount(now - startedAt, clueIntervalMs, totalClues);
  if (visible >= totalClues) return null;
  return startedAt + visible * Math.max(1, clueIntervalMs);
};

/* ------------------------------ clue ladder ------------------------------ */

export type G1ClueKind = G1Clue['kind'];

/** Lower-signal clues about the player's profile. The opening clue always comes from here. */
export const G1_PROFILE_CLUE_KINDS: readonly G1ClueKind[] = ['NATIONALITY', 'POSITION', 'AGE'];

/** High-signal clues that usually give the answer away, so they always come last. */
export const G1_GIVEAWAY_CLUE_KINDS: readonly G1ClueKind[] = ['CAREER', 'SHIRT_NUMBER'];

/**
 * Ages within this many years of the answer's are treated as *not* ruling a player out: nobody
 * knows a footballer's age to the year, so "Age: 24" does not fairly eliminate a 25-year-old.
 */
export const G1_AGE_TOLERANCE_YEARS = 1;

/**
 * The most distractors that may survive the opening clue: one third of them, rounded down (one of
 * three with the default four options, none with two or three options, three of eleven at twelve).
 *
 * Why a third: zero decoys would make the opening clue a one-step lookup for anyone who knows the
 * players — i.e. plain trivia. Letting most of them survive (the old behaviour: three Spaniards out
 * of four when the only clue is "Spain") makes the early guess a coin flip. One plausible decoy
 * keeps the early guess a real knowledge call while guaranteeing the first clue already rules out
 * most of the board.
 */
export const maxOpeningDecoys = (optionCount: number): number => Math.max(0, Math.floor((optionCount - 1) / 3));

const careerKey = (profile: PlayerProfile): string =>
  profile.career.map((entry) => entry.teamName).join('\u0000');

/** The clue of `kind` for this profile, or `null` when the data cannot support it. */
const clueFor = (profile: PlayerProfile, kind: G1ClueKind): G1Clue | null => {
  const { player } = profile;
  switch (kind) {
    case 'NATIONALITY':
      return player.nationality === null ? null : { kind, value: player.nationality };
    case 'POSITION':
      // "Position: UNKNOWN" is not a clue.
      return player.position === 'UNKNOWN' ? null : { kind, value: player.position };
    case 'AGE':
      return player.age === null ? null : { kind, value: player.age };
    case 'CAREER':
      return profile.career.length === 0 ? null : { kind, clubs: profile.career.map((entry) => entry.teamName) };
    case 'SHIRT_NUMBER':
      return player.shirtNumber === null ? null : { kind, value: player.shirtNumber };
  }
};

/**
 * Whether a clue of `kind` about `answer` visibly rules `candidate` out. Missing data on the
 * candidate's side counts as *not* ruled out: the guesser knows the real player, not our dataset, so
 * we must not assume a player with no recorded nationality is not, say, Spanish.
 */
export const clueRulesOut = (kind: G1ClueKind, answer: PlayerProfile, candidate: PlayerProfile): boolean => {
  const a = answer.player;
  const c = candidate.player;
  switch (kind) {
    case 'NATIONALITY':
      return a.nationality !== null && c.nationality !== null && a.nationality !== c.nationality;
    case 'POSITION':
      return a.position !== 'UNKNOWN' && c.position !== 'UNKNOWN' && a.position !== c.position;
    case 'AGE':
      return a.age !== null && c.age !== null && Math.abs(a.age - c.age) > G1_AGE_TOLERANCE_YEARS;
    case 'CAREER':
      return answer.career.length > 0 && candidate.career.length > 0 && careerKey(answer) !== careerKey(candidate);
    case 'SHIRT_NUMBER':
      return a.shirtNumber !== null && c.shirtNumber !== null && a.shirtNumber !== c.shirtNumber;
  }
};

/** Index of the first clue in `order` that rules `candidate` out, or `null` if none ever does. */
const eliminationStep = (
  order: readonly G1ClueKind[],
  answer: PlayerProfile,
  candidate: PlayerProfile,
): number | null => {
  const index = order.findIndex((kind) => clueRulesOut(kind, answer, candidate));
  return index === -1 ? null : index;
};

/**
 * The per-round clue order: the profile tier shuffled, then the give-away tier shuffled.
 *
 * The opening clue is the first profile kind (in shuffled order) that can support a fair option set
 * — enough candidates it rules out to fill all non-decoy slots, and enough candidates it does *not*
 * rule out (but a later clue does) to supply the decoys. That keeps the variety of a random opener
 * while dodging a degenerate one: in a pool where nearly everyone is Spanish, a Spanish answer opens
 * on position or age instead; the only Dane in the pool does not open on "Denmark". If no kind is
 * good enough (a tiny pool), the kind that rules out the most candidates opens.
 */
export const orderClues = (
  answer: PlayerProfile,
  candidates: readonly PlayerProfile[],
  optionCount: number,
  rng: Rng,
): readonly G1ClueKind[] => {
  const available = (kind: G1ClueKind): boolean => clueFor(answer, kind) !== null;
  const profileKinds = rng.shuffle(G1_PROFILE_CLUE_KINDS.filter(available));
  const giveawayKinds = rng.shuffle(G1_GIVEAWAY_CLUE_KINDS.filter(available));

  const decoysWanted = Math.min(maxOpeningDecoys(optionCount), Math.max(0, optionCount - 1));
  const needed = Math.max(0, optionCount - 1 - decoysWanted);
  const ruledOutBy = (kind: G1ClueKind): number =>
    candidates.filter((candidate) => clueRulesOut(kind, answer, candidate)).length;
  // A decoy must survive this opener but be ruled out by some other clue the answer can show.
  const decoysFor = (kind: G1ClueKind): number =>
    candidates.filter(
      (candidate) =>
        !clueRulesOut(kind, answer, candidate) &&
        [...profileKinds, ...giveawayKinds].some((other) => other !== kind && clueRulesOut(other, answer, candidate)),
    ).length;

  // Best: the opener splits the board *and* leaves a plausible decoy (the only Dane in the pool
  // would make "Nationality: Denmark" a one-step lookup). Next best: it at least splits the board.
  let opening: G1ClueKind | undefined =
    profileKinds.find((kind) => ruledOutBy(kind) >= needed && decoysFor(kind) >= decoysWanted) ??
    profileKinds.find((kind) => ruledOutBy(kind) >= needed);
  if (opening === undefined) {
    let best = -1;
    for (const kind of profileKinds) {
      const count = ruledOutBy(kind);
      if (count > best) {
        best = count;
        opening = kind;
      }
    }
  }
  const rest = profileKinds.filter((kind) => kind !== opening);
  return [...(opening === undefined ? [] : [opening]), ...rest, ...giveawayKinds];
};

const openingValueKey = (kind: G1ClueKind, profile: PlayerProfile): string => {
  const clue = clueFor(profile, kind);
  if (clue === null) return '';
  return clue.kind === 'CAREER' ? clue.clubs.join('\u0000') : String(clue.value);
};

/**
 * Picks `optionCount - 1` distractors that make the option list an elimination puzzle for `order`.
 *
 * Preference order (each step only runs while slots remain):
 *  1. up to `maxOpeningDecoys` **decoys** — survive the opening clue, ruled out by a later one;
 *  2. **ruled out by the opening clue**, taken round-robin across that clue's values (one Brazilian,
 *     one French, one Italian — not three Brazilians) so the opener actually splits the board;
 *  3. fallback for thin pools: extra decoys beyond the cap;
 *  4. last resort: candidates no clue can separate from the answer, then duplicate names.
 *
 * Steps 1–2 alone guarantee a fair, solvable set; 3–4 exist only so generation never fails while the
 * pool still holds `optionCount` usable profiles (general-dataset builds can be small). Names are
 * kept distinct from each other and from the answer whenever possible, since two identical buttons
 * cannot be told apart.
 */
export const selectDistractors = (
  answer: PlayerProfile,
  candidates: readonly PlayerProfile[],
  order: readonly G1ClueKind[],
  optionCount: number,
  rng: Rng,
): readonly PlayerProfile[] => {
  const wanted = Math.max(0, optionCount - 1);
  const opening = order[0];
  const shuffled = rng.shuffle(candidates.filter((candidate) => candidate.player.id !== answer.player.id));

  const early: PlayerProfile[] = [];
  const decoys: PlayerProfile[] = [];
  const inseparable: PlayerProfile[] = [];
  for (const candidate of shuffled) {
    const step = eliminationStep(order, answer, candidate);
    if (step === null) inseparable.push(candidate);
    else if (step === 0) early.push(candidate);
    else decoys.push(candidate);
  }

  const picked: PlayerProfile[] = [];
  const pickedIds = new Set<string>();
  const names = new Set<string>([answer.player.name.trim().toLowerCase()]);
  const duplicateNames: PlayerProfile[] = [];
  const take = (candidate: PlayerProfile): void => {
    if (picked.length >= wanted || pickedIds.has(candidate.player.id)) return;
    const name = candidate.player.name.trim().toLowerCase();
    if (names.has(name)) {
      duplicateNames.push(candidate);
      return;
    }
    picked.push(candidate);
    pickedIds.add(candidate.player.id);
    names.add(name);
  };

  // 1. Capped decoys.
  const decoyCap = Math.min(maxOpeningDecoys(optionCount), wanted);
  for (const decoy of decoys) {
    if (picked.length >= decoyCap) break;
    take(decoy);
  }

  // 2. Ruled out by the opener, spread across its values. Group order is already random because the
  //    groups are built from the shuffled list.
  const groups = new Map<string, PlayerProfile[]>();
  for (const candidate of early) {
    const key = opening === undefined ? '' : openingValueKey(opening, candidate);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  const queues = [...groups.values()];
  for (let round = 0; picked.length < wanted && queues.some((queue) => queue.length > round); round += 1) {
    for (const queue of queues) {
      const candidate = queue[round];
      if (candidate !== undefined) take(candidate);
    }
  }

  // 3–4. Fallbacks for thin pools.
  for (const candidate of decoys) take(candidate);
  for (const candidate of inseparable) take(candidate);
  for (const candidate of duplicateNames.splice(0)) {
    if (picked.length >= wanted) break;
    if (pickedIds.has(candidate.player.id)) continue;
    picked.push(candidate);
    pickedIds.add(candidate.player.id);
  }
  return picked;
};

export const g1GuessThePlayer = defineGameModule<G1Shape>({
  id: G1_ID,
  category: 'general',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasCareerHistory'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: G1_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const usable = ctx.data.profiles.filter(
      (profile) =>
        profile.player.nationality !== null && profile.player.age !== null && profile.career.length > 0,
    );
    if (usable.length < ctx.config.optionCount) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'not enough player profiles' };
    }

    const fresh = usable.filter((profile) => !ctx.usedContentKeys.includes(profile.player.id));
    if (fresh.length === 0) {
      return { ok: false, reason: 'NO_UNUSED_CONTENT', detail: 'every profile already used' };
    }

    const chosen = ctx.rng.pick(fresh);
    if (chosen === undefined) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'empty pool' };
    }

    // Distractors come from the same usable pool as answers (nationality and age known, career
    // present), so every clue kind can be compared against them.
    const candidates = usable.filter((profile) => profile.player.id !== chosen.player.id);
    const order = orderClues(chosen, candidates, ctx.config.optionCount, ctx.rng);
    const clues = order.map((kind) => clueFor(chosen, kind)).filter((clue): clue is G1Clue => clue !== null);

    const distractors = selectDistractors(chosen, candidates, order, ctx.config.optionCount, ctx.rng);
    const options = ctx.rng.shuffle(
      [chosen, ...distractors].map((profile) => ({ playerId: profile.player.id, name: profile.player.name })),
    );

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'GUESS_PLAYER',
          clues,
          options: options.slice(),
          clueIntervalMs: ctx.config.clueIntervalMs,
        },
        privatePayloads: {},
        solution: {
          playerId: chosen.player.id,
          name: chosen.player.name,
          clueCount: clues.length,
        },
        contentKey: chosen.player.id,
        answerWindowMs: ctx.config.answerWindowMs,
        turnOrder: null,
      },
    };
  },

  validateSubmission: (ctx) => {
    const parsed = submissionSchema.safeParse(ctx.raw);
    if (!parsed.success) return { ok: false, code: 'SCHEMA', detail: parsed.error.message };
    const known = ctx.round.publicPayload.options.some((option) => option.playerId === parsed.data.playerId);
    if (!known) return { ok: false, code: 'UNKNOWN_OPTION', detail: parsed.data.playerId };
    return { ok: true, payload: parsed.data };
  },

  scoreRound: (ctx) => {
    const answerId = ctx.round.solution.playerId;
    const clueCount = ctx.round.publicPayload.clues.length;
    const cluesUsedBy = (elapsedMs: number): number =>
      visibleClueCount(elapsedMs, ctx.config.clueIntervalMs, clueCount);

    const scores = scoreChoiceRound<G1Shape>({
      players: ctx.players,
      submissions: ctx.submissions,
      isCorrect: (submission) => submission.payload.playerId === answerId,
      accuracyFactor: (submission) =>
        Math.max(ctx.config.minCredit, 1 - (cluesUsedBy(submission.elapsedMs) - 1) * ctx.config.cluePenalty),
      meta: (submission) => ({
        pickedPlayerId: submission.payload.playerId,
        cluesUsed: cluesUsedBy(submission.elapsedMs),
      }),
      windowMs: ctx.round.answerWindowMs,
      scoring: ctx.scoring,
    });

    const correct = ctx.submissions.filter((submission) => submission.payload.playerId === answerId);
    // Misses are drink-rolled per player (see `rollDrinkSips`); the config fields are on/off switches.
    const penalties: PenaltyEvent[] = [
      ...rolledSelfPenalties(
        ctx.rng,
        ctx.submissions
          .filter((submission) => submission.payload.playerId !== answerId)
          .map((submission) => submission.playerId),
        'WRONG_ANSWER',
        ctx.config.wrongAnswerSips > 0,
      ),
      ...rolledSelfPenalties(
        ctx.rng,
        nonSubmitters<G1Shape>(ctx.players, ctx.submissions),
        'NO_ANSWER',
        ctx.config.noAnswerSips > 0,
      ),
    ];

    for (const submission of correct) {
      if (cluesUsedBy(submission.elapsedMs) === 1 && ctx.config.firstClueBonusSips > 0) {
        penalties.push(
          penalty(submission.playerId, 'others', ctx.config.firstClueBonusSips, 'ROUND_WON', {
            cluesUsed: 1,
          }),
        );
      }
    }

    return {
      scores,
      winnerIds: pickRoundWinners(scores),
      penalties,
      summary: { answerPlayerId: answerId, correctCount: correct.length, clueCount },
    };
  },

  projectRound: (ctx) => {
    const payload = ctx.round.publicPayload;
    if (ctx.visibility === 'revealed') {
      return { publicPayload: payload, privatePayload: null, solution: ctx.round.solution };
    }
    const visible = visibleClueCount(
      ctx.now - ctx.round.startedAt,
      ctx.config.clueIntervalMs,
      payload.clues.length,
    );
    return {
      publicPayload: { ...payload, clues: payload.clues.slice(0, visible) },
      privatePayload: null,
      solution: null,
    };
  },

  // `projectRound` above reads `ctx.now`, so the engine must be told when its output changes.
  nextContentChangeAt: (ctx) =>
    nextClueUnlockAt(ctx.now, ctx.round.startedAt, ctx.config.clueIntervalMs, ctx.round.publicPayload.clues.length),
});
