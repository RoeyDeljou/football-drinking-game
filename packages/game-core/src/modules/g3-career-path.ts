/**
 * G3 — Career Path (general, `simultaneous-answer`)
 *
 * A mystery footballer's club history is revealed **one club at a time, in chronological order**:
 * earliest club first, most recent (usually the most recognizable) club last. Name the player from a
 * fixed option list. Guess early and you keep more of the base points; every extra club costs
 * `cluePenalty` (floored at `minCredit`).
 *
 * Built on the lessons G1 Guess the Player already paid for:
 *
 *  - **Give-away last.** The chronology *is* the ladder, so the most recent club — the one everybody
 *    associates with the player — is always the final clue, never the opener.
 *  - **Options are an elimination puzzle** (see `selectCareerDistractors`): a club "rules out" an
 *    option when that footballer never played there. At most `maxOpeningDecoys(optionCount)` wrong
 *    options survive the first club (one of three at the default four options); the rest are ruled
 *    out immediately and are spread across *different* current clubs, not three players from the same
 *    squad. Every wrong option is ruled out by some club on the path, so the round is always
 *    solvable by the last clue whenever the pool allows it — and never fails to generate on a thin
 *    pool while `optionCount` usable profiles exist.
 *  - **Clues unlock from the injected clock**, never from stored state, and the module declares
 *    `nextContentChangeAt`, so the engine's `TICK` commits (and the transport rebroadcasts) exactly at
 *    each unlock. Without that hook a round would freeze on its first club — the G1 bug this contract
 *    exists to prevent.
 *  - **The whole path is always visible before the deadline.** The per-round unlock interval is
 *    shortened for long careers so the final club unlocks at least `finalClueHoldMs` before the answer
 *    window closes. The interval actually used is stored in the public payload and is the single
 *    source of truth for projection, scheduling and scoring.
 *  - **Misses are drink-rolled** (`rolledSelfPenalties`): the `wrongAnswerSips` / `noAnswerSips`
 *    config fields are on/off switches, exactly as in every other answer game.
 *
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
import { maxOpeningDecoys, nextClueUnlockAt, visibleClueCount } from './g1-guess-the-player.js';
import { footballPlayerIdSchema, nonSubmitters, rolledSelfPenalties, scoreChoiceRound } from './helpers.js';

export const G3_ID = asGameModuleId('G3');

/** The fastest the path may unlock, whatever the career length. Mirrors the config floor. */
export const G3_MIN_CLUE_INTERVAL_MS = 1_000;

const clubStepSchema = z
  .object({
    name: z.string().min(1),
    /** Season label as the data source gives it (e.g. `2014`, `2014/15`); `null` when unknown. */
    from: z.string().nullable(),
    /** `null` for the current club or an unknown end. */
    to: z.string().nullable(),
  })
  .strict();

export type G3ClubStep = z.infer<typeof clubStepSchema>;

const optionSchema = z.object({ playerId: footballPlayerIdSchema, name: z.string() }).strict();

const configSchema = z
  .object({
    answerWindowMs: z.number().int().min(5_000).max(300_000),
    /** Preferred time between clubs; shortened per round for long careers (see module doc). */
    clueIntervalMs: z.number().int().min(G3_MIN_CLUE_INTERVAL_MS).max(60_000),
    /** The full path stays on screen at least this long before the deadline. */
    finalClueHoldMs: z.number().int().min(0).max(120_000),
    /** Answers need at least this many (distinct consecutive) clubs; a one-club path is no path. */
    minClubs: z.number().int().min(2).max(15),
    /** Longer careers show only their most recent `maxClubs` clubs. */
    maxClubs: z.number().int().min(2).max(15),
    optionCount: z.number().int().min(2).max(12),
    /** Fraction of the base lost per extra club revealed. */
    cluePenalty: z.number().min(0).max(0.5),
    minCredit: z.number().min(0).max(1),
    /** On/off switch: `0` disables the penalty, any positive value enables a drink roll. */
    wrongAnswerSips: z.number().int().min(0).max(10),
    /** On/off switch: `0` disables the penalty, any positive value enables a drink roll. */
    noAnswerSips: z.number().int().min(0).max(10),
    /** Sips everyone else owes when somebody names the player from the first club alone. */
    firstClueBonusSips: z.number().int().min(0).max(10),
  })
  .strict()
  .superRefine((config, issue) => {
    if (config.minClubs > config.maxClubs) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['minClubs'], message: 'minClubs exceeds maxClubs' });
    }
    // Even at the fastest interval, the whole path must unlock `finalClueHoldMs` before the deadline.
    if ((config.maxClubs - 1) * G3_MIN_CLUE_INTERVAL_MS + config.finalClueHoldMs > config.answerWindowMs) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answerWindowMs'],
        message: 'answer window too short to reveal maxClubs clubs and hold the last one',
      });
    }
  });

const publicPayloadSchema = z
  .object({
    kind: z.literal('CAREER_PATH'),
    clubs: z.array(clubStepSchema).min(1),
    options: z.array(optionSchema).min(2),
    /** The unlock interval this round actually uses (source of truth for projection and scoring). */
    clueIntervalMs: z.number().int().min(G3_MIN_CLUE_INTERVAL_MS),
  })
  .strict();

const solutionSchema = z
  .object({ playerId: footballPlayerIdSchema, name: z.string(), clueCount: z.number().int() })
  .strict();

const submissionSchema = z.object({ playerId: footballPlayerIdSchema }).strict();

interface G3Shape {
  readonly config: z.infer<typeof configSchema>;
  readonly publicPayload: z.infer<typeof publicPayloadSchema>;
  readonly privatePayload: null;
  readonly solution: z.infer<typeof solutionSchema>;
  readonly submission: z.infer<typeof submissionSchema>;
}

export const G3_DEFAULT_CONFIG: G3Shape['config'] = {
  answerWindowMs: 45_000,
  clueIntervalMs: 7_000,
  finalClueHoldMs: 10_000,
  minClubs: 2,
  maxClubs: 8,
  optionCount: 4,
  cluePenalty: 0.12,
  minCredit: 0.25,
  wrongAnswerSips: 2,
  noAnswerSips: 3,
  firstClueBonusSips: 1,
};

/* ------------------------------ career path ------------------------------ */

/** Case/whitespace-insensitive club identity, used for every "played there?" comparison. */
export const clubKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

const seasonLabel = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'unknown' ? null : trimmed;
};

const leadingYear = (value: string | null): number | null => {
  const match = value === null ? null : /^(\d{4})/.exec(value.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
};

/**
 * A profile's full career as a chronological club path, earliest first:
 *  - entries with a blank club name are dropped;
 *  - when *every* entry carries a start year, entries are stably sorted by (start year, end year),
 *    with an open end (`null` — the current club) last; otherwise the provider's order is trusted
 *    (providers already emit careers chronologically — sorting on partial dates would scramble them);
 *  - consecutive spells at the same club collapse into one step (two contracts at one club are one
 *    stop on the path), keeping the first spell's start and the last spell's end.
 *
 * A return to a club after spells elsewhere (a loan and back) is kept: it is part of the path.
 */
export const careerPath = (profile: PlayerProfile): readonly G3ClubStep[] => {
  const entries = profile.career
    .filter((entry) => entry.teamName.trim() !== '')
    .map((entry, index) => ({
      index,
      name: entry.teamName.trim(),
      from: seasonLabel(entry.fromSeason),
      to: seasonLabel(entry.toSeason),
      fromYear: leadingYear(entry.fromSeason),
      toYear: entry.toSeason === null ? null : leadingYear(entry.toSeason),
    }));

  const dated = entries.every((entry) => entry.fromYear !== null);
  const ordered = dated
    ? entries.slice().sort((a, b) => {
        const byStart = (a.fromYear ?? 0) - (b.fromYear ?? 0);
        if (byStart !== 0) return byStart;
        const endA = a.toYear ?? Number.POSITIVE_INFINITY;
        const endB = b.toYear ?? Number.POSITIVE_INFINITY;
        if (endA !== endB) return endA < endB ? -1 : 1;
        return a.index - b.index;
      })
    : entries;

  const path: G3ClubStep[] = [];
  for (const entry of ordered) {
    const last = path[path.length - 1];
    if (last !== undefined && clubKey(last.name) === clubKey(entry.name)) {
      path[path.length - 1] = { ...last, to: entry.to };
      continue;
    }
    path.push({ name: entry.name, from: entry.from, to: entry.to });
  }
  return path;
};

/** The clubs shown for an answer: its most recent `maxClubs` steps (the give-away stays last). */
export const shownPath = (path: readonly G3ClubStep[], maxClubs: number): readonly G3ClubStep[] =>
  path.length <= maxClubs ? path : path.slice(path.length - maxClubs);

/**
 * The unlock interval for a path of `clubCount` clubs: the configured interval, shortened just enough
 * that the last club unlocks no later than `answerWindowMs - finalClueHoldMs`, and never below
 * `G3_MIN_CLUE_INTERVAL_MS` (the config refinement guarantees that floor still fits).
 */
export const roundClueInterval = (config: G3Shape['config'], clubCount: number): number => {
  if (clubCount <= 1) return config.clueIntervalMs;
  const budget = Math.floor((config.answerWindowMs - config.finalClueHoldMs) / (clubCount - 1));
  return Math.max(G3_MIN_CLUE_INTERVAL_MS, Math.min(config.clueIntervalMs, budget));
};

/**
 * The index of the first club on `path` that rules `candidateClubs` out (the candidate never played
 * there), or `null` when no club on the path does — i.e. the candidate played for every club shown
 * and the path alone cannot separate them from the answer. A candidate with no recorded career is
 * never ruled out: the guesser knows the real footballer, not our dataset.
 */
export const careerEliminationStep = (
  path: readonly G3ClubStep[],
  candidateClubs: ReadonlySet<string>,
): number | null => {
  if (candidateClubs.size === 0) return null;
  const index = path.findIndex((step) => !candidateClubs.has(clubKey(step.name)));
  return index === -1 ? null : index;
};

/** Round-robin over groups, preserving each group's (already random) internal order. */
const roundRobin = <T>(groups: readonly (readonly T[])[]): readonly T[] => {
  const out: T[] = [];
  for (let round = 0; groups.some((group) => group.length > round); round += 1) {
    for (const group of groups) {
      const item = group[round];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
};

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): readonly (readonly T[])[] => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.values()];
};

/**
 * Picks `optionCount - 1` distractors that make the option list an elimination puzzle for `path`.
 *
 * Preference order (each step only runs while slots remain):
 *  1. up to `maxOpeningDecoys` **decoys** — played for the first club, ruled out by a later one —
 *     spread across different elimination steps, so they drop out at different points of the path;
 *  2. **ruled out by the first club**, taken round-robin across their own most recent clubs (one
 *     current Inter player, one Lyon player, one Porto player — never three from one squad);
 *  3. fallback for thin pools: extra decoys beyond the cap;
 *  4. last resort: candidates the path cannot separate from the answer, then duplicate names.
 *
 * Steps 1–2 alone guarantee a fair, solvable set; 3–4 exist only so generation never fails while the
 * pool still holds `optionCount` usable profiles. Names are kept distinct from each other and from the
 * answer whenever possible, since two identical buttons cannot be told apart.
 */
export const selectCareerDistractors = (
  answer: PlayerProfile,
  path: readonly G3ClubStep[],
  candidates: readonly PlayerProfile[],
  optionCount: number,
  rng: Rng,
): readonly PlayerProfile[] => {
  const wanted = Math.max(0, optionCount - 1);
  const shuffled = rng.shuffle(candidates.filter((candidate) => candidate.player.id !== answer.player.id));

  const early: { readonly profile: PlayerProfile; readonly currentClub: string }[] = [];
  const decoys: { readonly profile: PlayerProfile; readonly step: number }[] = [];
  const inseparable: PlayerProfile[] = [];
  for (const candidate of shuffled) {
    const own = careerPath(candidate);
    const step = careerEliminationStep(path, new Set(own.map((entry) => clubKey(entry.name))));
    if (step === null) inseparable.push(candidate);
    else if (step === 0) {
      const last = own[own.length - 1];
      early.push({ profile: candidate, currentClub: last === undefined ? '' : clubKey(last.name) });
    } else decoys.push({ profile: candidate, step });
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

  // 1. Capped decoys, spread across the step at which they drop out.
  const decoyCap = Math.min(maxOpeningDecoys(optionCount), wanted);
  const spreadDecoys = roundRobin(groupBy(decoys, (decoy) => String(decoy.step))).map((decoy) => decoy.profile);
  for (const decoy of spreadDecoys) {
    if (picked.length >= decoyCap) break;
    take(decoy);
  }

  // 2. Ruled out by the first club, spread across their own current clubs.
  for (const candidate of roundRobin(groupBy(early, (entry) => entry.currentClub))) take(candidate.profile);

  // 3–4. Fallbacks for thin pools.
  for (const decoy of spreadDecoys) take(decoy);
  for (const candidate of inseparable) take(candidate);
  for (const candidate of duplicateNames.splice(0)) {
    if (picked.length >= wanted) break;
    if (pickedIds.has(candidate.player.id)) continue;
    picked.push(candidate);
    pickedIds.add(candidate.player.id);
  }
  return picked;
};

/** How many answer picks to try before settling for one the pool cannot fully separate. */
const ANSWER_ATTEMPTS = 24;

export const g3CareerPath = defineGameModule<G3Shape>({
  id: G3_ID,
  category: 'general',
  kind: 'simultaneous-answer',
  dataRequirements: ['hasCareerHistory'],
  minPlayers: 1,
  maxPlayers: null,
  allowResubmission: false,
  defaultConfig: G3_DEFAULT_CONFIG,
  configSchema,
  publicPayloadSchema,
  privatePayloadSchema: z.null(),
  solutionSchema,
  submissionSchema,

  generateRound: (ctx) => {
    const { config } = ctx;
    const paths = new Map<string, readonly G3ClubStep[]>();
    const clubs = new Map<string, ReadonlySet<string>>();
    for (const profile of ctx.data.profiles) {
      const path = careerPath(profile);
      paths.set(profile.player.id, path);
      clubs.set(profile.player.id, new Set(path.map((step) => clubKey(step.name))));
    }
    const pathOf = (profile: PlayerProfile): readonly G3ClubStep[] => paths.get(profile.player.id) ?? [];

    // Anyone with a recorded career can be an option; answers also need a real path.
    const usable = ctx.data.profiles.filter((profile) => pathOf(profile).length > 0);
    if (usable.length < config.optionCount) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'not enough career histories' };
    }
    const answerable = usable.filter((profile) => pathOf(profile).length >= config.minClubs);
    if (answerable.length === 0) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: `no career with ${config.minClubs}+ clubs` };
    }
    const fresh = answerable.filter((profile) => !ctx.usedContentKeys.includes(profile.player.id));
    if (fresh.length === 0) {
      return { ok: false, reason: 'NO_UNUSED_CONTENT', detail: 'every career already used' };
    }

    // Prefer an answer the pool can fully separate (enough candidates ruled out by some club), so the
    // round is solvable; settle for the first pick only when no attempt finds one (a thin pool).
    // Distinct picks (no replacement), so a pool with a single separable answer always finds it.
    const wanted = config.optionCount - 1;
    let chosen: PlayerProfile | undefined;
    let fallback: PlayerProfile | undefined;
    for (const pick of ctx.rng.sample(fresh, ANSWER_ATTEMPTS)) {
      fallback ??= pick;
      const path = shownPath(pathOf(pick), config.maxClubs);
      let separable = 0;
      for (const candidate of usable) {
        if (candidate.player.id === pick.player.id) continue;
        if (careerEliminationStep(path, clubs.get(candidate.player.id) ?? new Set()) !== null) separable += 1;
        if (separable >= wanted) break;
      }
      if (separable >= wanted) {
        chosen = pick;
        break;
      }
    }
    chosen ??= fallback;
    if (chosen === undefined) {
      return { ok: false, reason: 'INSUFFICIENT_DATA', detail: 'empty pool' };
    }

    const path = shownPath(pathOf(chosen), config.maxClubs);
    const distractors = selectCareerDistractors(chosen, path, usable, config.optionCount, ctx.rng);
    const options = ctx.rng.shuffle(
      [chosen, ...distractors].map((profile) => ({ playerId: profile.player.id, name: profile.player.name })),
    );

    return {
      ok: true,
      round: {
        publicPayload: {
          kind: 'CAREER_PATH',
          clubs: path.slice(),
          options: options.slice(),
          clueIntervalMs: roundClueInterval(config, path.length),
        },
        privatePayloads: {},
        solution: { playerId: chosen.player.id, name: chosen.player.name, clueCount: path.length },
        contentKey: chosen.player.id,
        answerWindowMs: config.answerWindowMs,
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
    const payload = ctx.round.publicPayload;
    const clueCount = payload.clubs.length;
    const cluesUsedBy = (elapsedMs: number): number => visibleClueCount(elapsedMs, payload.clueIntervalMs, clueCount);

    const scores = scoreChoiceRound<G3Shape>({
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
        nonSubmitters<G3Shape>(ctx.players, ctx.submissions),
        'NO_ANSWER',
        ctx.config.noAnswerSips > 0,
      ),
    ];

    for (const submission of correct) {
      if (cluesUsedBy(submission.elapsedMs) === 1 && ctx.config.firstClueBonusSips > 0) {
        penalties.push(
          penalty(submission.playerId, 'others', ctx.config.firstClueBonusSips, 'ROUND_WON', { cluesUsed: 1 }),
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
    const visible = visibleClueCount(ctx.now - ctx.round.startedAt, payload.clueIntervalMs, payload.clubs.length);
    return {
      publicPayload: { ...payload, clubs: payload.clubs.slice(0, visible) },
      privatePayload: null,
      solution: null,
    };
  },

  // `projectRound` above reads `ctx.now`, so the engine must be told when its output changes.
  nextContentChangeAt: (ctx) =>
    nextClueUnlockAt(
      ctx.now,
      ctx.round.startedAt,
      ctx.round.publicPayload.clueIntervalMs,
      ctx.round.publicPayload.clubs.length,
    ),
});
