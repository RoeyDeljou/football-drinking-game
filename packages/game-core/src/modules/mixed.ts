/**
 * Mixed — the "all games in one" rotation mode, one per category (`G-MIX` general, `M-MIX` matchday).
 *
 * A Mixed module is an ordinary `GameModule`: the reducer, projection and transport see one session of
 * one module and know nothing about rotation. Internally, every round is produced by a **different
 * sub-module drawn from the registry's own modules** of the same category, and every later hook
 * (`validateSubmission`, `scoreRound`, `projectRound`, `nextContentChangeAt`, `afterSubmission`)
 * reads which sub-module produced the current round from its stored payload and delegates to it.
 * Adding a new mixable game to the registry list makes it part of the rotation with no change here.
 *
 * **Eligibility (static).** A module can be rotated only if it is a `simultaneous-answer` game of this
 * category (one self-contained question per round — a `long-running-bet` such as M1 spans a whole
 * match and structurally cannot be "round 3"), does not observe live events (Mixed forwards no
 * `MATCH_EVENTS`), and does not allow resubmission (Mixed's own `allowResubmission` is `false`).
 *
 * **Eligibility (per round).** Of the configured sub-modules, only those `checkModulePlayable` accepts
 * against `ctx.data.quality` and whose player limits fit the room are candidates this round.
 *
 * **Selection + retry (per round).** Candidates are ordered by `orderMixedCandidates` — a shuffle-bag
 * rotation drawn from `ctx.rng` (never the one that ran last round when another exists; otherwise the
 * least-played so far first; random among ties) — and tried in that order: if a sub-module's own
 * `generateRound` fails for content reasons (its data is used up, or too thin in a way the quality
 * flags cannot see), the next candidate gets a real shot inside the *same* generation attempt. Only if
 * every candidate fails does the round fail, with the ordinary `INSUFFICIENT_DATA` /
 * `NO_UNUSED_CONTENT` reasons. The same seeded `ctx.rng` is threaded through selection and through
 * every delegated `generateRound`, so the same RNG state always yields the same sub-module and round.
 *
 * **Envelope.** `publicPayload` is `{ kind: 'MIXED', moduleId, inner }` where `inner` is the
 * sub-module's own payload (which carries its own `kind` literal: `GUESS_PLAYER`, `CAREER_PATH`,
 * `TRIVIA`, `WHO_IS_IT`, `SHIRT_NUMBER`, …), so a client renders the sub-game's existing screen.
 * `solution` and `RoundOutcome.summary` use `{ moduleId, inner }`. Submissions are **not** wrapped: a
 * player sends exactly what the sub-game expects, validated by the sub-module's own validator.
 *
 * **Content keys.** Stored as `<subModuleId>::<innerKey>`. Each delegated `generateRound` receives the
 * *inner* keys of every previous round (all sub-modules), so a footballer used as G1's answer is also
 * "used" for G3 (both key by footballer id) — a Mixed session never repeats the same content across
 * games whose keys denote the same thing, and keys of different formats simply never collide.
 *
 * **Shirt numbers are never shown when a sub-game asks for them.** Standalone M2 prints each option's
 * shirt number ("Pedri #8"); in a rotation that also contains M3 ("what is Pedri's shirt number?")
 * that would hand out M3's answers. So when the session's configured rotation (`config.modules`, not
 * just this round's candidates) contains a sub-game in `SHIRT_NUMBER_QUIZZES`, every round of a
 * sub-game in `SHIRT_NUMBER_DISPLAYS` has each option's `shirtNumber` replaced by `null`
 * (`suppressOptionShirtNumbers`) — in the stored payload at generation, and again (idempotently) in
 * the projection. Nothing is shown, so there is nothing to track: M3's candidate pool is untouched
 * and the rotation stays balanced for any session length. M2's solution and summary carry no shirt
 * number, so its reveal shows none either. Without a number-asking game configured, M2 keeps its
 * numbers. This lives only in Mixed: M2 and M3 run standalone exactly as before.
 *
 * Sub-modules always run on their own `defaultConfig`.
 */

import { z } from 'zod';
import type { DataRequirementKey } from '../data.js';
import { checkModulePlayable } from '../data.js';
import { EngineInvariantError } from '../errors.js';
import type { GameModuleId } from '../ids.js';
import { asGameModuleId } from '../ids.js';
import type {
  EngineGameModule,
  GameCategory,
  ModuleShape,
  RoundGenerationFailure,
  RoundKind,
  RoundView,
} from '../module.js';
import { defineGameModule } from '../module.js';
import type { Rng } from '../ports.js';
import { M2_ID } from './m2-who-is-that-player.js';
import { M3_ID } from './m3-shirt-number.js';

export const G_MIX_ID = asGameModuleId('G-MIX');
export const M_MIX_ID = asGameModuleId('M-MIX');

/** Round kinds that fit "one different quick question per round". */
export const MIXABLE_ROUND_KINDS: readonly RoundKind[] = ['simultaneous-answer'];

/** Separator between the sub-module id and its own content key. Module ids never contain it. */
export const MIXED_CONTENT_KEY_SEPARATOR = '::';

export const mixedContentKey = (moduleId: GameModuleId, innerKey: string): string =>
  `${moduleId}${MIXED_CONTENT_KEY_SEPARATOR}${innerKey}`;

export interface ParsedMixedContentKey {
  /** `null` for a key that was not written by a Mixed module (never the case inside a Mixed session). */
  readonly moduleId: GameModuleId | null;
  readonly innerKey: string;
}

export const parseMixedContentKey = (key: string): ParsedMixedContentKey => {
  const at = key.indexOf(MIXED_CONTENT_KEY_SEPARATOR);
  if (at <= 0) return { moduleId: null, innerKey: key };
  return { moduleId: asGameModuleId(key.slice(0, at)), innerKey: key.slice(at + MIXED_CONTENT_KEY_SEPARATOR.length) };
};

/** Sub-games whose answer is a footballer's shirt number. */
export const SHIRT_NUMBER_QUIZZES: readonly GameModuleId[] = [M3_ID];

/** Sub-games whose public payload lists footballers as `options` carrying their `shirtNumber`. */
export const SHIRT_NUMBER_DISPLAYS: readonly GameModuleId[] = [M2_ID];

/**
 * Whether a `subId` round inside a rotation configured with `configured` must hide shirt numbers:
 * it displays them, and a game that asks for them is part of the session's configured rotation.
 */
export const suppressesShirtNumbers = (subId: GameModuleId, configured: readonly GameModuleId[]): boolean =>
  SHIRT_NUMBER_DISPLAYS.includes(subId) && configured.some((moduleId) => SHIRT_NUMBER_QUIZZES.includes(moduleId));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `payload` with every `options[i].shirtNumber` replaced by `null` (M2's `PitchPlayer` options, whose
 * schema allows `null` — the client then shows no number). Everything else is copied untouched;
 * idempotent; a payload without an `options` array is returned as is.
 */
export const suppressOptionShirtNumbers = (payload: unknown): unknown => {
  if (!isRecord(payload)) return payload;
  const options = payload['options'];
  if (!Array.isArray(options)) return payload;
  return {
    ...payload,
    options: options.map((option: unknown) =>
      isRecord(option) && 'shirtNumber' in option ? { ...option, shirtNumber: null } : option,
    ),
  };
};

/** Whether `module` can take part in a `category` Mixed rotation (see module doc, "static"). */
export const isMixable = (module: EngineGameModule, category: GameCategory): boolean =>
  module.category === category &&
  MIXABLE_ROUND_KINDS.includes(module.kind) &&
  !module.supportsLiveEvents &&
  !module.allowResubmission;

/**
 * The order in which this round's candidates are tried: a shuffle-bag rotation.
 *
 *  1. the sub-module that produced the previous round goes last (unless it is the only candidate), so
 *     consecutive rounds are different games whenever possible;
 *  2. otherwise, fewest rounds played so far this session first — every eligible game gets its turn
 *     before any gets a second one;
 *  3. ties are broken by one `rng.shuffle` of the candidates, so the rotation is random, not fixed.
 *
 * Consumes exactly one `rng.shuffle` of `candidates` (nothing for zero or one candidate beyond what
 * `shuffle` itself draws), and is fully determined by the RNG state, `candidates` order and `history`.
 */
export const orderMixedCandidates = <T extends { readonly id: GameModuleId }>(
  candidates: readonly T[],
  history: readonly (GameModuleId | null)[],
  rng: Rng,
): readonly T[] => {
  const previous = history.length === 0 ? null : (history[history.length - 1] ?? null);
  const played = new Map<GameModuleId, number>();
  for (const id of history) if (id !== null) played.set(id, (played.get(id) ?? 0) + 1);
  const avoidPrevious = candidates.length > 1;
  const rank = (candidate: T): readonly [number, number] => [
    avoidPrevious && candidate.id === previous ? 1 : 0,
    played.get(candidate.id) ?? 0,
  ];
  return rng
    .shuffle(candidates)
    .map((candidate, order) => ({ candidate, order, rank: rank(candidate) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.order - b.order)
    .map((entry) => entry.candidate);
};

/** Requirements shared by *every* module in `modules`: a sound necessary condition for any of them. */
const commonRequirements = (modules: readonly EngineGameModule[]): readonly DataRequirementKey[] => {
  const [first, ...rest] = modules;
  if (first === undefined) return [];
  return first.dataRequirements.filter((key) => rest.every((module) => module.dataRequirements.includes(key)));
};

/* -------------------------------- schemas -------------------------------- */

const moduleIdSchema = z
  .string()
  .min(1)
  .transform((value): GameModuleId => asGameModuleId(value));

const baseConfigSchema = z.object({ modules: z.array(moduleIdSchema).min(1) }).strict();

const basePublicPayloadSchema = z
  .object({ kind: z.literal('MIXED'), moduleId: moduleIdSchema, inner: z.unknown() })
  .strict();

const baseSolutionSchema = z.object({ moduleId: moduleIdSchema, inner: z.unknown() }).strict();

export type MixedConfig = z.infer<typeof baseConfigSchema>;
/** `inner` is the picked sub-module's own public payload (it carries its own `kind` literal). */
export type MixedPublicPayload = z.infer<typeof basePublicPayloadSchema>;
/** `inner` is the picked sub-module's own solution. */
export type MixedSolution = z.infer<typeof baseSolutionSchema>;

/** `RoundOutcome.summary` of a Mixed round: the sub-module's own summary, tagged with its id. */
export interface MixedSummary {
  readonly moduleId: GameModuleId;
  readonly inner: unknown;
}

interface MixedShape {
  readonly config: MixedConfig;
  readonly publicPayload: MixedPublicPayload;
  /** Passed through untouched from the sub-module (always `null`/absent for today's mixable games). */
  readonly privatePayload: unknown;
  readonly solution: MixedSolution;
  /** Passed through untouched: validated by the picked sub-module's own validator. */
  readonly submission: unknown;
}

export interface MixedModuleOptions {
  readonly id: GameModuleId;
  readonly category: GameCategory;
  /**
   * Every module the rotation may draw from — typically the registry's full standalone list. Filtered
   * here with `isMixable`, so passing the whole list (M1 included) is correct and intended.
   */
  readonly pool: readonly EngineGameModule[];
  /**
   * Mixable modules left out of the **default** rotation (`defaultConfig.modules`) while staying
   * eligible: a host can still name them in `config.modules`. For games whose client screen has not
   * shipped yet. Data requirements are declared over the default rotation.
   */
  readonly excludeFromDefault?: readonly GameModuleId[];
}

const failureRank = (reason: RoundGenerationFailure): number => (reason === 'NO_UNUSED_CONTENT' ? 0 : 1);

/**
 * Builds a Mixed rotation module over `pool`. Throws `EngineInvariantError` at construction if the
 * pool has no mixable module for `category` or contains the Mixed module's own id.
 */
export const createMixedModule = (options: MixedModuleOptions): EngineGameModule => {
  const { id, category } = options;
  if (options.pool.some((module) => module.id === id)) {
    throw new EngineInvariantError(`${id} cannot rotate over itself`);
  }
  const eligible = options.pool.filter((module) => isMixable(module, category));
  if (eligible.length === 0) {
    throw new EngineInvariantError(`${id} has no mixable ${category} module to rotate over`);
  }
  const byId = new Map<GameModuleId, EngineGameModule>(eligible.map((module) => [module.id, module]));
  const knownId = (value: GameModuleId): boolean => byId.has(value);

  const configSchema = baseConfigSchema.superRefine((config, issue) => {
    const seen = new Set<GameModuleId>();
    config.modules.forEach((moduleId, index) => {
      if (!knownId(moduleId)) {
        issue.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modules', index],
          message: `${moduleId} is not a mixable ${category} game`,
        });
      }
      if (seen.has(moduleId)) {
        issue.addIssue({ code: z.ZodIssueCode.custom, path: ['modules', index], message: `${moduleId} listed twice` });
      }
      seen.add(moduleId);
    });
  });
  const publicPayloadSchema = basePublicPayloadSchema.refine((payload) => knownId(payload.moduleId), {
    message: 'unknown sub-game',
    path: ['moduleId'],
  });
  const solutionSchema = baseSolutionSchema.refine((solution) => knownId(solution.moduleId), {
    message: 'unknown sub-game',
    path: ['moduleId'],
  });

  /** The sub-module behind a stored round, and the round as that sub-module stored it. */
  const unwrap = (round: RoundView<MixedShape>): { sub: EngineGameModule; view: RoundView<ModuleShape> } => {
    const { publicPayload, solution } = round;
    if (publicPayload.moduleId !== solution.moduleId) {
      throw new EngineInvariantError(
        `${id} round ${round.id} mixes ${publicPayload.moduleId} payload with ${solution.moduleId} solution`,
      );
    }
    const sub = byId.get(publicPayload.moduleId);
    if (sub === undefined) throw new EngineInvariantError(`${id} has no sub-game ${publicPayload.moduleId}`);
    return {
      sub,
      view: {
        id: round.id,
        index: round.index,
        startedAt: round.startedAt,
        answerWindowMs: round.answerWindowMs,
        deadlineAt: round.deadlineAt,
        publicPayload: publicPayload.inner,
        privatePayloads: round.privatePayloads,
        solution: solution.inner,
        turn: round.turn,
        liveWindow: round.liveWindow,
      },
    };
  };

  /**
   * The sub-game's public payload as Mixed stores and shows it: shirt numbers suppressed when the
   * configured rotation asks for them (see module doc). The result is still the sub-game's own
   * payload, re-validated by its own schema on every later hook (projection included), so a future
   * display game whose options cannot carry `null` fails loudly there instead of being served.
   */
  const innerPublicPayload = (sub: EngineGameModule, payload: unknown, configured: readonly GameModuleId[]): unknown =>
    suppressesShirtNumbers(sub.id, configured) ? suppressOptionShirtNumbers(payload) : payload;

  const excluded = options.excludeFromDefault ?? [];
  const defaults = eligible.filter((module) => !excluded.includes(module.id));
  if (defaults.length === 0) {
    throw new EngineInvariantError(`${id} excludes every mixable ${category} module from its default rotation`);
  }
  const defaultConfig: MixedConfig = { modules: defaults.map((module) => module.id) };

  return defineGameModule<MixedShape>({
    id,
    category,
    kind: 'simultaneous-answer',
    // Only what *every* sub-game needs (e.g. `hasLineups` for matchday). Per-round playability is
    // decided inside `generateRound`, against whichever sub-games the data can actually serve.
    dataRequirements: commonRequirements(defaults),
    // …and at least one sub-game's full set, so the picker greys Mixed out when no sub-game can play.
    dataRequirementsAnyOf: defaults.map((module) => module.dataRequirements),
    minPlayers: Math.min(...eligible.map((module) => module.minPlayers)),
    maxPlayers: eligible.some((module) => module.maxPlayers === null)
      ? null
      : Math.max(...eligible.map((module) => module.maxPlayers ?? 0)),
    allowResubmission: false,
    defaultConfig,
    configSchema,
    publicPayloadSchema,
    privatePayloadSchema: z.unknown(),
    solutionSchema,
    submissionSchema: z.unknown(),

    generateRound: (ctx) => {
      const history = ctx.usedContentKeys.map(parseMixedContentKey);
      const usedInnerKeys = history.map((entry) => entry.innerKey);

      const skipped: string[] = [];
      const candidates = ctx.config.modules.flatMap((moduleId) => {
        const sub = byId.get(moduleId);
        if (sub === undefined) return [];
        const playability = checkModulePlayable(sub, ctx.data.quality);
        if (!playability.playable) {
          skipped.push(`${sub.id}=${playability.code}`);
          return [];
        }
        const count = ctx.players.length;
        if (count < sub.minPlayers || (sub.maxPlayers !== null && count > sub.maxPlayers)) {
          skipped.push(`${sub.id}=PLAYER_COUNT`);
          return [];
        }
        return [sub];
      });
      if (candidates.length === 0) {
        return { ok: false, reason: 'INSUFFICIENT_DATA', detail: `no playable sub-game (${skipped.join(', ')})` };
      }

      const ordered = orderMixedCandidates(
        candidates,
        history.map((entry) => entry.moduleId),
        ctx.rng,
      );
      const failures: { readonly moduleId: GameModuleId; readonly reason: RoundGenerationFailure; readonly detail: string }[] = [];
      for (const sub of ordered) {
        const result = sub.generateRound({
          config: sub.defaultConfig,
          sessionId: ctx.sessionId,
          roundIndex: ctx.roundIndex,
          players: ctx.players,
          data: ctx.data,
          rng: ctx.rng,
          now: ctx.now,
          usedContentKeys: usedInnerKeys,
          defaultAnswerWindowMs: ctx.defaultAnswerWindowMs,
        });
        if (!result.ok) {
          failures.push({ moduleId: sub.id, reason: result.reason, detail: result.detail ?? '' });
          continue;
        }
        const round = result.round;
        return {
          ok: true,
          round: {
            publicPayload: {
              kind: 'MIXED',
              moduleId: sub.id,
              inner: innerPublicPayload(sub, round.publicPayload, ctx.config.modules),
            },
            privatePayloads: round.privatePayloads,
            solution: { moduleId: sub.id, inner: round.solution },
            contentKey: mixedContentKey(sub.id, round.contentKey),
            answerWindowMs: round.answerWindowMs,
            turnOrder: round.turnOrder,
          },
        };
      }

      // Every candidate failed. "Used up" only if that is what *every* candidate reported.
      const worst = failures.reduce((max, failure) => Math.max(max, failureRank(failure.reason)), 0);
      return {
        ok: false,
        reason: worst === 0 ? 'NO_UNUSED_CONTENT' : 'INSUFFICIENT_DATA',
        detail: failures.map((failure) => `${failure.moduleId}=${failure.reason}:${failure.detail}`).join(', '),
      };
    },

    validateSubmission: (ctx) => {
      const { sub, view } = unwrap(ctx.round);
      const result = sub.validateSubmission({
        config: sub.defaultConfig,
        round: view,
        playerId: ctx.playerId,
        raw: ctx.raw,
        submittedAt: ctx.submittedAt,
        elapsedMs: ctx.elapsedMs,
        alreadySubmitted: ctx.alreadySubmitted,
      });
      return result.ok ? { ok: true, payload: result.payload } : result;
    },

    afterSubmission: (ctx) => {
      const { sub, view } = unwrap(ctx.round);
      return (
        sub.afterSubmission({
          config: sub.defaultConfig,
          round: view,
          playerId: ctx.playerId,
          payload: ctx.payload,
          submissions: ctx.submissions,
          players: ctx.players,
          now: ctx.now,
        }) ?? { lockRound: false, eliminate: [] }
      );
    },

    scoreRound: (ctx) => {
      const { sub, view } = unwrap(ctx.round);
      const outcome = sub.scoreRound({
        config: sub.defaultConfig,
        round: view,
        submissions: ctx.submissions,
        players: ctx.players,
        scoring: ctx.scoring,
        now: ctx.now,
        rng: ctx.rng,
      });
      const summary: MixedSummary = { moduleId: sub.id, inner: outcome.summary };
      return { ...outcome, summary };
    },

    projectRound: (ctx) => {
      const { sub, view } = unwrap(ctx.round);
      const projection = sub.projectRound({
        config: sub.defaultConfig,
        round: view,
        viewerId: ctx.viewerId,
        visibility: ctx.visibility,
        now: ctx.now,
      });
      return {
        // Already suppressed in the stored round; re-applied so the projection can never show more.
        publicPayload: {
          kind: 'MIXED',
          moduleId: sub.id,
          inner: innerPublicPayload(sub, projection.publicPayload, ctx.config.modules),
        },
        privatePayload: projection.privatePayload,
        // Never more than the sub-game itself would show: `null` pre-reveal stays `null`.
        solution:
          ctx.visibility === 'revealed' && projection.solution !== null
            ? { moduleId: sub.id, inner: projection.solution }
            : null,
      };
    },

    // Mandatory delegation: a timed sub-game (G1 clues, G3 clubs) must keep rebroadcasting its unlocks
    // inside a Mixed session, or its rounds freeze on the first clue. Untimed sub-games return `null`.
    nextContentChangeAt: (ctx) => {
      const { sub, view } = unwrap(ctx.round);
      return sub.nextContentChangeAt({ config: sub.defaultConfig, round: view, now: ctx.now });
    },
  });
};
