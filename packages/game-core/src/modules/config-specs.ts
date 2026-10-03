/**
 * Host-editable game settings, described as plain JSON-friendly data for the host's pre-game editor.
 *
 * A game listed in `GAME_CONFIG_SPECS` is customisable; one that is absent is played with its
 * defaults. The web builds the editor from `fields`, starts from `defaults`, and sends
 * `{ ...defaults, ...edits }` (dropping `optional` keys the host did not use) as `SELECT_GAME.config`.
 * The module's own Zod schema stays the single source of truth: the reducer rejects anything else
 * with `INVALID_CONFIG` and a `path: message` detail. A test (`config-specs.test.ts`) pins every
 * limit here to that schema, so the two cannot drift.
 *
 * No user-facing copy: a field is identified by `key` (the config property) and the client owns its
 * wording. Only fields that make sense to edit are listed; every other config key keeps its default.
 */

import type { GameModuleId } from '../ids.js';
import { LIVE_EVENT_KINDS } from './live-event-kinds.js';
import { M1_DEFAULT_CONFIG, M1_ID } from './m1-match-markets.js';
import { M4_DEFAULT_CONFIG, M4_ID } from './m4-your-man.js';
import { M5_DEFAULT_CONFIG, M5_ID, M5_LABEL_MAX_LENGTH } from './m5-event-roulette.js';
import {
  M6_DEFAULT_CONFIG,
  M6_ID,
  M6_LABEL_MAX_LENGTH,
  M6_MAX_HOUSE_CELLS,
  M6_MAX_POOL_CELLS,
} from './m6-match-bingo.js';
import { M7_DEFAULT_CONFIG, M7_ID } from './m7-minute-sniper.js';
import { M8_DEFAULT_CONFIG, M8_ID } from './m8-stat-duel.js';
import { M9_DEFAULT_CONFIG, M9_ID, QUESTION_TYPES } from './m9-flash-rounds.js';

export type ConfigUnit = 'sips' | 'ms' | 'minutes' | 'count';

interface FieldBase {
  /** The config property. */
  readonly key: string;
  /** `true`: the key may be left out of the config entirely (an opt-in customisation). */
  readonly optional: boolean;
}

export type ConfigFieldSpec =
  | (FieldBase & {
      readonly type: 'integer';
      readonly min: number;
      readonly max: number;
      /** Suggested UI step; every integer in `min..max` is valid. */
      readonly step: number;
      readonly unit: ConfigUnit;
    })
  | (FieldBase & { readonly type: 'boolean' })
  /** Exactly one of `options`. */
  | (FieldBase & { readonly type: 'choice'; readonly options: readonly (string | number)[] })
  /** A distinct, non-empty subset of `options`. */
  | (FieldBase & { readonly type: 'multiChoice'; readonly options: readonly string[]; readonly minItems: number })
  /** `{ [option]: text }`, any subset of `options`; text trimmed, `1..maxLength` chars. */
  | (FieldBase & { readonly type: 'labelOverrides'; readonly options: readonly string[]; readonly maxLength: number })
  /** Distinct (case-insensitive) free-text entries; trimmed, `1..maxLength` chars each. */
  | (FieldBase & {
      readonly type: 'textList';
      readonly minItems: number;
      readonly maxItems: number;
      readonly maxLength: number;
    })
  /** M6 `{ event, side, count, label? }[]`; vocabulary and limits in `M6_BINGO_VOCABULARY`. */
  | (FieldBase & {
      readonly type: 'bingoCellPool';
      readonly minItems: number;
      readonly maxItems: number;
      readonly labelMaxLength: number;
    });

export interface GameConfigSpec {
  readonly moduleId: GameModuleId;
  /** The module's `defaultConfig` (a complete, valid config). */
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly fields: readonly ConfigFieldSpec[];
}

const sips = (key: string, max: number, min = 0): ConfigFieldSpec => ({
  key,
  optional: false,
  type: 'integer',
  min,
  max,
  step: 1,
  unit: 'sips',
});

const specs: readonly GameConfigSpec[] = [
  {
    moduleId: M1_ID,
    defaults: M1_DEFAULT_CONFIG,
    fields: [
      sips('sipsPerLostMarket', 5),
      sips('worstSlipSips', 10),
      sips('perfectSlipSips', 10),
      sips('noAnswerSips', 10),
    ],
  },
  {
    moduleId: M4_ID,
    defaults: M4_DEFAULT_CONFIG,
    fields: [
      sips('foulSips', 10),
      sips('missSips', 10),
      sips('yellowSips', 10),
      sips('redSips', 10),
      sips('ownGoalSips', 10),
      sips('goalSips', 10),
      sips('assistSips', 10),
      { key: 'includeGoalkeepers', optional: false, type: 'boolean' },
    ],
  },
  {
    moduleId: M5_ID,
    defaults: M5_DEFAULT_CONFIG,
    fields: [
      { key: 'drinker', optional: false, type: 'choice', options: ['owner', 'others'] },
      { key: 'windowMinutes', optional: false, type: 'integer', min: 3, max: 45, step: 1, unit: 'minutes' },
      { key: 'eventKinds', optional: false, type: 'multiChoice', options: [...LIVE_EVENT_KINDS], minItems: 1 },
      sips('sipsPerFire', 5, 1),
      {
        key: 'labels',
        optional: true,
        type: 'labelOverrides',
        options: [...LIVE_EVENT_KINDS],
        maxLength: M5_LABEL_MAX_LENGTH,
      },
    ],
  },
  {
    moduleId: M6_ID,
    defaults: M6_DEFAULT_CONFIG,
    fields: [
      { key: 'size', optional: false, type: 'choice', options: [3, 4] },
      sips('lineSips', 5),
      sips('fullHouseSips', 10),
      {
        key: 'cellPool',
        optional: true,
        type: 'bingoCellPool',
        minItems: 1,
        maxItems: M6_MAX_POOL_CELLS,
        labelMaxLength: M6_LABEL_MAX_LENGTH,
      },
      {
        key: 'houseCells',
        optional: true,
        type: 'textList',
        minItems: 1,
        maxItems: M6_MAX_HOUSE_CELLS,
        maxLength: M6_LABEL_MAX_LENGTH,
      },
      // Capped further by the house cells given and the card size (`size²`).
      { key: 'housePerCard', optional: true, type: 'integer', min: 0, max: 16, step: 1, unit: 'count' },
    ],
  },
  {
    moduleId: M7_ID,
    defaults: M7_DEFAULT_CONFIG,
    fields: [sips('furthestSips', 10), sips('noAnswerSips', 10)],
  },
  {
    moduleId: M8_ID,
    defaults: M8_DEFAULT_CONFIG,
    fields: [sips('duelSips', 10)],
  },
  {
    moduleId: M9_ID,
    defaults: M9_DEFAULT_CONFIG,
    fields: [
      { key: 'types', optional: false, type: 'multiChoice', options: [...QUESTION_TYPES], minItems: 1 },
      { key: 'answerWindowMs', optional: false, type: 'integer', min: 10_000, max: 60_000, step: 5_000, unit: 'ms' },
      sips('wrongAnswerSips', 10),
      sips('noAnswerSips', 10),
    ],
  },
];

/** Every customisable game, keyed by module id. A game absent here plays with its defaults. */
export const GAME_CONFIG_SPECS: Readonly<Partial<Record<string, GameConfigSpec>>> = Object.fromEntries(
  specs.map((spec) => [spec.moduleId, spec]),
);

export const gameConfigSpecFor = (moduleId: GameModuleId): GameConfigSpec | null =>
  GAME_CONFIG_SPECS[moduleId] ?? null;
