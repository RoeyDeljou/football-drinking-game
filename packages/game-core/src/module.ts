/**
 * The `GameModule` contract.
 *
 * A game is a plugin: config schema, round generation, submission validation, scoring, penalty
 * emission and per-viewer projection. Adding a game must never require editing the engine, so the
 * engine only ever talks to the *erased* form of a module (`EngineGameModule`), where payloads are
 * `unknown` and are re-narrowed by the module's own Zod schemas at the boundary.
 *
 * Round shapes are modelled explicitly rather than forced into one "ask a question" mould:
 *
 * | kind                  | catalog examples                         | what makes it different            |
 * |-----------------------|------------------------------------------|------------------------------------|
 * | `simultaneous-answer` | M2, M3, M7, M9, M10, G1, G2, G6, G9      | one prompt, everyone answers at once |
 * | `private-card`        | M4 Your Man, M5 Event Roulette, M6 Bingo | per-player private assignment, ticked off by live events |
 * | `long-running-bet`    | M1 Match Markets                         | a multi-market slip resolved incrementally as events arrive |
 * | `pairing`             | M8 Stat Duel                             | head-to-head pairings inside one round |
 * | `turn-based`          | G8 Teammate Chain                        | one active player at a time, elimination |
 */

import type { MatchEvent } from '@fdg/football-data';
import type { ZodType, ZodTypeDef } from 'zod';
import type { DataRequirementKey, RoundDataContext } from './data.js';
import { EngineInvariantError } from './errors.js';
import type { GameModuleId, PlayerId, RoundId, SessionId } from './ids.js';
import { asPlayerId } from './ids.js';
import type { PenaltyEvent } from './penalties.js';
import type { Rng } from './ports.js';
import type { RoundScore, ScoringConfig } from './scoring.js';

export type GameCategory = 'matchday' | 'general';

export const ROUND_KINDS = [
  'simultaneous-answer',
  'private-card',
  'long-running-bet',
  'pairing',
  'turn-based',
] as const;

export type RoundKind = (typeof ROUND_KINDS)[number];

/**
 * The five payload types a module works with. Declare them as `z.infer<typeof schema>` so the
 * static types and the runtime schemas cannot drift apart.
 */
export interface ModuleShape {
  readonly config: unknown;
  readonly publicPayload: unknown;
  readonly privatePayload: unknown;
  readonly solution: unknown;
  readonly submission: unknown;
}

/** Per-player map. Reads are `T | undefined`, which is what `noUncheckedIndexedAccess` gives us. */
export type PerPlayer<T> = Readonly<Partial<Record<PlayerId, T>>>;

export interface RoundPlayerView {
  readonly id: PlayerId;
  readonly nickname: string;
  readonly connected: boolean;
  readonly score: number;
  /** Consecutive correct answers *before* this round. */
  readonly streak: number;
}

export interface TurnState {
  readonly order: readonly PlayerId[];
  readonly activeIndex: number;
  readonly eliminated: readonly PlayerId[];
}

/* -------------------------------------------------------------------------- */
/* Round generation                                                            */
/* -------------------------------------------------------------------------- */

export interface RoundGenerationContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly sessionId: SessionId;
  readonly roundIndex: number;
  readonly players: readonly RoundPlayerView[];
  readonly data: RoundDataContext;
  readonly rng: Rng;
  readonly now: number;
  /** `contentKey`s already used this session, so a generator never repeats itself. */
  readonly usedContentKeys: readonly string[];
  /** The room's configured answer window, which a module may shorten or ignore. */
  readonly defaultAnswerWindowMs: number;
}

export interface GeneratedRound<S extends ModuleShape> {
  readonly publicPayload: S['publicPayload'];
  /** Only populated by `private-card` (and similar) games. */
  readonly privatePayloads: PerPlayer<S['privatePayload']>;
  /** Hidden until reveal. `projectFor` strips this. */
  readonly solution: S['solution'];
  /** Stable identity of the *content* (e.g. the footballer being guessed), used for dedupe. */
  readonly contentKey: string;
  /** `null` means the round has no deadline — long-running bets and private cards. */
  readonly answerWindowMs: number | null;
  /** Required for `turn-based`, ignored otherwise. */
  readonly turnOrder: readonly PlayerId[] | null;
}

export type RoundGenerationFailure =
  'INSUFFICIENT_DATA' | 'NO_UNUSED_CONTENT' | 'NOT_ENOUGH_PLAYERS' | 'WRONG_ROUND_CONTEXT';

export type GenerateRoundResult<S extends ModuleShape> =
  | { readonly ok: true; readonly round: GeneratedRound<S> }
  | { readonly ok: false; readonly reason: RoundGenerationFailure; readonly detail: string | null };

/* -------------------------------------------------------------------------- */
/* Submission                                                                  */
/* -------------------------------------------------------------------------- */

export interface RoundView<S extends ModuleShape> {
  readonly id: RoundId;
  readonly index: number;
  readonly startedAt: number;
  readonly answerWindowMs: number | null;
  readonly deadlineAt: number | null;
  readonly publicPayload: S['publicPayload'];
  readonly privatePayloads: PerPlayer<S['privatePayload']>;
  readonly solution: S['solution'];
  readonly turn: TurnState | null;
}

export type SubmissionRejectionCode =
  | 'SCHEMA'
  | 'UNKNOWN_OPTION'
  | 'OUT_OF_RANGE'
  | 'INCOMPLETE'
  | 'NOT_ALLOWED'
  /** A bet is being placed or changed while an outcome it covers is already known. */
  | 'MARKET_SETTLED'
  /** The slip locked when the match started; nothing can be filed or edited after that. */
  | 'SLIP_LOCKED';

export interface ValidateSubmissionContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly round: RoundView<S>;
  readonly playerId: PlayerId;
  /** Unvalidated input straight off the wire. */
  readonly raw: unknown;
  readonly submittedAt: number;
  readonly elapsedMs: number;
  readonly alreadySubmitted: boolean;
}

export type SubmissionValidation<S extends ModuleShape> =
  | { readonly ok: true; readonly payload: S['submission'] }
  | {
      readonly ok: false;
      readonly code: SubmissionRejectionCode;
      readonly detail: string | null;
    };

export interface TypedSubmission<S extends ModuleShape> {
  readonly playerId: PlayerId;
  readonly payload: S['submission'];
  readonly submittedAt: number;
  readonly elapsedMs: number;
}

export interface AfterSubmissionContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly round: RoundView<S>;
  readonly playerId: PlayerId;
  readonly payload: S['submission'];
  readonly submissions: readonly TypedSubmission<S>[];
  readonly players: readonly RoundPlayerView[];
  readonly now: number;
}

/** Lets `turn-based` games eliminate a player or end the round early. */
export interface AfterSubmissionResult {
  readonly lockRound: boolean;
  readonly eliminate: readonly PlayerId[];
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface ScoreRoundContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly round: RoundView<S>;
  readonly submissions: readonly TypedSubmission<S>[];
  readonly players: readonly RoundPlayerView[];
  readonly scoring: ScoringConfig;
  readonly now: number;
}

export interface RoundOutcome {
  readonly scores: readonly RoundScore[];
  readonly winnerIds: readonly PlayerId[];
  readonly penalties: readonly PenaltyEvent[];
  /** Structured, JSON-serializable detail for the reveal screen. Never a user-facing sentence. */
  readonly summary: unknown;
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

export type RoundVisibility = 'pre-reveal' | 'revealed';

export interface ProjectRoundContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly round: RoundView<S>;
  /** `null` for a shared "big screen" view that belongs to no player. */
  readonly viewerId: PlayerId | null;
  readonly visibility: RoundVisibility;
  readonly now: number;
}

export interface RoundProjection<S extends ModuleShape> {
  readonly publicPayload: S['publicPayload'];
  readonly privatePayload: S['privatePayload'] | null;
  /** Must be `null` unless `visibility === 'revealed'`; `projectFor` enforces this regardless. */
  readonly solution: S['solution'] | null;
}

/* -------------------------------------------------------------------------- */
/* Live events (long-running bets, private cards)                              */
/* -------------------------------------------------------------------------- */

export interface ObserveEventsContext<S extends ModuleShape> {
  readonly config: S['config'];
  readonly round: RoundView<S>;
  /** Only events the engine has not shown this round before — de-duplicated by `MatchEvent.id`. */
  readonly events: readonly MatchEvent[];
  readonly submissions: readonly TypedSubmission<S>[];
  readonly players: readonly RoundPlayerView[];
  readonly now: number;
}

export interface ObserveEventsResult<S extends ModuleShape> {
  readonly publicPayload: S['publicPayload'];
  readonly solution: S['solution'];
  readonly privatePayloads: PerPlayer<S['privatePayload']>;
  /** Penalties that fire mid-round (a lost market, a bingo line, your man getting booked). */
  readonly penalties: readonly PenaltyEvent[];
  /** Points to add immediately, before the round resolves. */
  readonly scoreDeltas: readonly RoundScore[];
  /** `true` ends the round: the engine locks it, scores it and moves to reveal. */
  readonly resolved: boolean;
}

/* -------------------------------------------------------------------------- */
/* The module itself                                                           */
/* -------------------------------------------------------------------------- */

export interface GameModuleDefinition<S extends ModuleShape> {
  readonly id: GameModuleId;
  readonly category: GameCategory;
  readonly kind: RoundKind;
  readonly dataRequirements: readonly DataRequirementKey[];
  readonly minPlayers: number;
  readonly maxPlayers: number | null;
  /** May a player replace an accepted submission while the round is open? (M1 slip edits.) */
  readonly allowResubmission: boolean;
  readonly defaultConfig: S['config'];
  readonly configSchema: ZodType<S['config'], ZodTypeDef, unknown>;
  readonly publicPayloadSchema: ZodType<S['publicPayload'], ZodTypeDef, unknown>;
  readonly privatePayloadSchema: ZodType<S['privatePayload'], ZodTypeDef, unknown>;
  readonly solutionSchema: ZodType<S['solution'], ZodTypeDef, unknown>;
  readonly submissionSchema: ZodType<S['submission'], ZodTypeDef, unknown>;
  generateRound(ctx: RoundGenerationContext<S>): GenerateRoundResult<S>;
  validateSubmission(ctx: ValidateSubmissionContext<S>): SubmissionValidation<S>;
  scoreRound(ctx: ScoreRoundContext<S>): RoundOutcome;
  projectRound(ctx: ProjectRoundContext<S>): RoundProjection<S>;
  observeEvents?: (ctx: ObserveEventsContext<S>) => ObserveEventsResult<S>;
  afterSubmission?: (ctx: AfterSubmissionContext<S>) => AfterSubmissionResult;
}

export type ConfigParseResult =
  | { readonly ok: true; readonly config: unknown }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The type-erased module the engine stores in its registry. Payloads are `unknown` here; the
 * wrapper produced by `defineGameModule` re-narrows them with the module's own schemas.
 */
export interface EngineGameModule {
  readonly id: GameModuleId;
  readonly category: GameCategory;
  readonly kind: RoundKind;
  readonly dataRequirements: readonly DataRequirementKey[];
  readonly minPlayers: number;
  readonly maxPlayers: number | null;
  readonly allowResubmission: boolean;
  readonly defaultConfig: unknown;
  readonly supportsLiveEvents: boolean;
  parseConfig(input: unknown): ConfigParseResult;
  generateRound(ctx: RoundGenerationContext<ModuleShape>): GenerateRoundResult<ModuleShape>;
  validateSubmission(ctx: ValidateSubmissionContext<ModuleShape>): SubmissionValidation<ModuleShape>;
  scoreRound(ctx: ScoreRoundContext<ModuleShape>): RoundOutcome;
  projectRound(ctx: ProjectRoundContext<ModuleShape>): RoundProjection<ModuleShape>;
  observeEvents(ctx: ObserveEventsContext<ModuleShape>): ObserveEventsResult<ModuleShape> | null;
  afterSubmission(ctx: AfterSubmissionContext<ModuleShape>): AfterSubmissionResult | null;
}

const parseWith = <T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, label: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EngineInvariantError(`${label} failed its own schema: ${result.error.message}`);
  }
  return result.data;
};

const parsePerPlayer = <T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  value: PerPlayer<unknown>,
  label: string,
): PerPlayer<T> => {
  const out: Partial<Record<PlayerId, T>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[asPlayerId(key)] = parseWith(schema, raw, label);
  }
  return out;
};

/**
 * Wrap a typed module definition into the erased form the engine consumes.
 *
 * Every payload crossing the boundary is validated, so a module can never be handed a round that
 * belongs to a different game — and a corrupt store fails loudly instead of scoring nonsense.
 */
export const defineGameModule = <S extends ModuleShape>(
  definition: GameModuleDefinition<S>,
): EngineGameModule => {
  const typedRound = (round: RoundView<ModuleShape>): RoundView<S> => ({
    id: round.id,
    index: round.index,
    startedAt: round.startedAt,
    answerWindowMs: round.answerWindowMs,
    deadlineAt: round.deadlineAt,
    publicPayload: parseWith(
      definition.publicPayloadSchema,
      round.publicPayload,
      `${definition.id} publicPayload`,
    ),
    privatePayloads: parsePerPlayer(
      definition.privatePayloadSchema,
      round.privatePayloads,
      `${definition.id} privatePayload`,
    ),
    solution: parseWith(definition.solutionSchema, round.solution, `${definition.id} solution`),
    turn: round.turn,
  });

  const typedConfig = (config: unknown): S['config'] =>
    parseWith(definition.configSchema, config, `${definition.id} config`);

  const typedSubmissions = (
    submissions: readonly TypedSubmission<ModuleShape>[],
  ): readonly TypedSubmission<S>[] =>
    submissions.map((submission) => ({
      playerId: submission.playerId,
      submittedAt: submission.submittedAt,
      elapsedMs: submission.elapsedMs,
      payload: parseWith(definition.submissionSchema, submission.payload, `${definition.id} submission`),
    }));

  return {
    id: definition.id,
    category: definition.category,
    kind: definition.kind,
    dataRequirements: definition.dataRequirements,
    minPlayers: definition.minPlayers,
    maxPlayers: definition.maxPlayers,
    allowResubmission: definition.allowResubmission,
    defaultConfig: definition.defaultConfig,
    supportsLiveEvents: definition.observeEvents !== undefined,

    parseConfig: (input: unknown): ConfigParseResult => {
      const result = definition.configSchema.safeParse(input);
      return result.success
        ? { ok: true, config: result.data }
        : {
            ok: false,
            issues: result.error.issues.map(
              (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            ),
          };
    },

    generateRound: (ctx) =>
      definition.generateRound({
        config: typedConfig(ctx.config),
        sessionId: ctx.sessionId,
        roundIndex: ctx.roundIndex,
        players: ctx.players,
        data: ctx.data,
        rng: ctx.rng,
        now: ctx.now,
        usedContentKeys: ctx.usedContentKeys,
        defaultAnswerWindowMs: ctx.defaultAnswerWindowMs,
      }),

    validateSubmission: (ctx) =>
      definition.validateSubmission({
        config: typedConfig(ctx.config),
        round: typedRound(ctx.round),
        playerId: ctx.playerId,
        raw: ctx.raw,
        submittedAt: ctx.submittedAt,
        elapsedMs: ctx.elapsedMs,
        alreadySubmitted: ctx.alreadySubmitted,
      }),

    scoreRound: (ctx) =>
      definition.scoreRound({
        config: typedConfig(ctx.config),
        round: typedRound(ctx.round),
        submissions: typedSubmissions(ctx.submissions),
        players: ctx.players,
        scoring: ctx.scoring,
        now: ctx.now,
      }),

    projectRound: (ctx) =>
      definition.projectRound({
        config: typedConfig(ctx.config),
        round: typedRound(ctx.round),
        viewerId: ctx.viewerId,
        visibility: ctx.visibility,
        now: ctx.now,
      }),

    observeEvents: (ctx) => {
      const observe = definition.observeEvents;
      if (observe === undefined) return null;
      return observe({
        config: typedConfig(ctx.config),
        round: typedRound(ctx.round),
        events: ctx.events,
        submissions: typedSubmissions(ctx.submissions),
        players: ctx.players,
        now: ctx.now,
      });
    },

    afterSubmission: (ctx) => {
      const hook = definition.afterSubmission;
      if (hook === undefined) return null;
      return hook({
        config: typedConfig(ctx.config),
        round: typedRound(ctx.round),
        playerId: ctx.playerId,
        payload: parseWith(definition.submissionSchema, ctx.payload, `${definition.id} submission`),
        submissions: typedSubmissions(ctx.submissions),
        players: ctx.players,
        now: ctx.now,
      });
    },
  };
};
