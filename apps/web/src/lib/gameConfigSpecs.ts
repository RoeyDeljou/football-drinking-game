/**
 * The host-editable settings of each customisable game, as plain data for the pre-game editor.
 *
 * This mirrors the engine's `GAME_CONFIG_SPECS` and `M6_BINGO_VOCABULARY` (packages/game-core
 * `modules/config-specs.ts`, `m6-match-bingo.ts`) rather than importing them: the client must not
 * bundle the engine (zod, every module). `gameConfigSpecs.test.ts` fails if this file and the engine
 * ever disagree, so the engine stays the single source of truth. Wording lives in `gameSettingsCopy.ts`.
 */

export type ConfigUnit = 'sips' | 'ms' | 'minutes' | 'count';

interface FieldBase {
  readonly key: string;
  readonly optional: boolean;
}

export type ConfigFieldSpec =
  | (FieldBase & { readonly type: 'integer'; readonly min: number; readonly max: number; readonly step: number; readonly unit: ConfigUnit })
  | (FieldBase & { readonly type: 'boolean' })
  | (FieldBase & { readonly type: 'choice'; readonly options: readonly (string | number)[] })
  | (FieldBase & { readonly type: 'multiChoice'; readonly options: readonly string[]; readonly minItems: number })
  | (FieldBase & { readonly type: 'labelOverrides'; readonly options: readonly string[]; readonly maxLength: number })
  | (FieldBase & { readonly type: 'textList'; readonly minItems: number; readonly maxItems: number; readonly maxLength: number })
  | (FieldBase & { readonly type: 'bingoCellPool'; readonly minItems: number; readonly maxItems: number; readonly labelMaxLength: number });

export interface GameConfigSpec {
  readonly moduleId: string;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly fields: readonly ConfigFieldSpec[];
}

export interface BingoDefaultCell {
  readonly id: string;
  readonly tier: 'common' | 'medium' | 'rare';
  readonly event: string;
  readonly side: 'home' | 'away' | null;
  readonly count: number;
}

export interface BingoVocabulary {
  readonly kinds: readonly string[];
  readonly sides: readonly ('home' | 'away' | null)[];
  readonly countPresets: Readonly<Record<string, readonly number[]>>;
  readonly maxCount: number;
  readonly defaultCells: readonly BingoDefaultCell[];
  readonly labelMaxLength: number;
  readonly maxPoolCells: number;
  readonly maxHouseCells: number;
}

const SPECS: readonly GameConfigSpec[] = [
  {
    "moduleId": "M1",
    "defaults": {
      "markets": [
        "MATCH_RESULT",
        "HT_RESULT",
        "BTTS",
        "OVER_UNDER_GOALS",
        "OVER_UNDER_CORNERS",
        "OVER_UNDER_CARDS",
        "PENALTY_AWARDED",
        "FIRST_SCORER",
        "ANYTIME_SCORER",
        "WINNING_MARGIN",
        "CORRECT_SCORE"
      ],
      "goalsLine": 2.5,
      "cornersLine": 9.5,
      "cardsLine": 3.5,
      "scorerOptionCount": 5,
      "slipWindowMs": 300000,
      "sipsPerLostMarket": 1,
      "worstSlipSips": 3,
      "perfectSlipSips": 2,
      "noAnswerSips": 4
    },
    "fields": [
      {
        "key": "sipsPerLostMarket",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 5,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "worstSlipSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "perfectSlipSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "noAnswerSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      }
    ]
  },
  {
    "moduleId": "M4",
    "defaults": {
      "foulSips": 1,
      "missSips": 1,
      "yellowSips": 2,
      "redSips": 4,
      "ownGoalSips": 3,
      "goalSips": 2,
      "assistSips": 1,
      "includeGoalkeepers": false
    },
    "fields": [
      {
        "key": "foulSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "missSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "yellowSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "redSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "ownGoalSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "goalSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "assistSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "includeGoalkeepers",
        "optional": false,
        "type": "boolean"
      }
    ]
  },
  {
    "moduleId": "M5",
    "defaults": {
      "windowMinutes": 10,
      "drinker": "owner",
      "sipsPerFire": 1,
      "eventKinds": [
        "CORNER",
        "OFFSIDE",
        "FOUL",
        "CARD",
        "SUBSTITUTION",
        "SHOT_ON_TARGET",
        "SHOT_OFF_TARGET"
      ]
    },
    "fields": [
      {
        "key": "drinker",
        "optional": false,
        "type": "choice",
        "options": [
          "owner",
          "others"
        ]
      },
      {
        "key": "windowMinutes",
        "optional": false,
        "type": "integer",
        "min": 3,
        "max": 45,
        "step": 1,
        "unit": "minutes"
      },
      {
        "key": "eventKinds",
        "optional": false,
        "type": "multiChoice",
        "options": [
          "CORNER",
          "OFFSIDE",
          "FOUL",
          "CARD",
          "SUBSTITUTION",
          "SHOT_ON_TARGET",
          "SHOT_OFF_TARGET",
          "GOAL"
        ],
        "minItems": 1
      },
      {
        "key": "sipsPerFire",
        "optional": false,
        "type": "integer",
        "min": 1,
        "max": 5,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "labels",
        "optional": true,
        "type": "labelOverrides",
        "options": [
          "CORNER",
          "OFFSIDE",
          "FOUL",
          "CARD",
          "SUBSTITUTION",
          "SHOT_ON_TARGET",
          "SHOT_OFF_TARGET",
          "GOAL"
        ],
        "maxLength": 40
      }
    ]
  },
  {
    "moduleId": "M6",
    "defaults": {
      "size": 3,
      "lineSips": 2,
      "fullHouseSips": 6
    },
    "fields": [
      {
        "key": "size",
        "optional": false,
        "type": "choice",
        "options": [
          3,
          4
        ]
      },
      {
        "key": "lineSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 5,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "fullHouseSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "cellPool",
        "optional": true,
        "type": "bingoCellPool",
        "minItems": 1,
        "maxItems": 64,
        "labelMaxLength": 40
      },
      {
        "key": "houseCells",
        "optional": true,
        "type": "textList",
        "minItems": 1,
        "maxItems": 16,
        "maxLength": 40
      },
      {
        "key": "housePerCard",
        "optional": true,
        "type": "integer",
        "min": 0,
        "max": 16,
        "step": 1,
        "unit": "count"
      }
    ]
  },
  {
    "moduleId": "M7",
    "defaults": {
      "pickWindowMs": 60000,
      "toleranceMinutes": 15,
      "furthestSips": 3,
      "noAnswerSips": 2
    },
    "fields": [
      {
        "key": "furthestSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "noAnswerSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      }
    ]
  },
  {
    "moduleId": "M8",
    "defaults": {
      "pickWindowMs": 90000,
      "duelSips": 2,
      "stats": [
        "SHOTS",
        "SHOTS_ON_TARGET",
        "GOAL_INVOLVEMENTS",
        "FEWEST_FOULS"
      ]
    },
    "fields": [
      {
        "key": "duelSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      }
    ]
  },
  {
    "moduleId": "M9",
    "defaults": {
      "answerWindowMs": 20000,
      "leadMinutes": 2,
      "wrongAnswerSips": 2,
      "noAnswerSips": 2,
      "types": [
        "GOAL_IN_WINDOW",
        "NEXT_GOAL_SIDE",
        "NEXT_CARD_SIDE",
        "CORNERS_OVER",
        "TEAM_SHOT_ON_TARGET"
      ]
    },
    "fields": [
      {
        "key": "types",
        "optional": false,
        "type": "multiChoice",
        "options": [
          "GOAL_IN_WINDOW",
          "NEXT_GOAL_SIDE",
          "NEXT_CARD_SIDE",
          "CORNERS_OVER",
          "TEAM_SHOT_ON_TARGET"
        ],
        "minItems": 1
      },
      {
        "key": "answerWindowMs",
        "optional": false,
        "type": "integer",
        "min": 10000,
        "max": 60000,
        "step": 5000,
        "unit": "ms"
      },
      {
        "key": "wrongAnswerSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      },
      {
        "key": "noAnswerSips",
        "optional": false,
        "type": "integer",
        "min": 0,
        "max": 10,
        "step": 1,
        "unit": "sips"
      }
    ]
  }
];

export const GAME_CONFIG_SPECS: Readonly<Partial<Record<string, GameConfigSpec>>> = Object.fromEntries(SPECS.map((spec) => [spec.moduleId, spec]));

export const gameConfigSpecFor = (moduleId: string): GameConfigSpec | null => GAME_CONFIG_SPECS[moduleId] ?? null;

export const BINGO_VOCABULARY: BingoVocabulary = {
  "kinds": [
    "CORNER",
    "OFFSIDE",
    "FOUL",
    "CARD",
    "SUBSTITUTION",
    "SHOT_ON_TARGET",
    "SHOT_OFF_TARGET",
    "GOAL"
  ],
  "sides": [
    "home",
    "away",
    null
  ],
  "countPresets": {
    "CORNER": [
      1,
      3,
      5
    ],
    "OFFSIDE": [
      1,
      2
    ],
    "FOUL": [
      3,
      6
    ],
    "CARD": [
      1
    ],
    "SUBSTITUTION": [
      1,
      4
    ],
    "SHOT_ON_TARGET": [
      1,
      2,
      4
    ],
    "SHOT_OFF_TARGET": [
      1,
      3
    ],
    "GOAL": [
      1,
      2
    ]
  },
  "maxCount": 10,
  "defaultCells": [
    {
      "id": "CORNER:any:1",
      "tier": "common",
      "event": "CORNER",
      "side": null,
      "count": 1
    },
    {
      "id": "CORNER:any:3",
      "tier": "common",
      "event": "CORNER",
      "side": null,
      "count": 3
    },
    {
      "id": "CORNER:home:1",
      "tier": "common",
      "event": "CORNER",
      "side": "home",
      "count": 1
    },
    {
      "id": "CORNER:away:1",
      "tier": "common",
      "event": "CORNER",
      "side": "away",
      "count": 1
    },
    {
      "id": "FOUL:any:3",
      "tier": "common",
      "event": "FOUL",
      "side": null,
      "count": 3
    },
    {
      "id": "FOUL:any:6",
      "tier": "common",
      "event": "FOUL",
      "side": null,
      "count": 6
    },
    {
      "id": "SHOT_OFF_TARGET:any:1",
      "tier": "common",
      "event": "SHOT_OFF_TARGET",
      "side": null,
      "count": 1
    },
    {
      "id": "SHOT_OFF_TARGET:any:3",
      "tier": "common",
      "event": "SHOT_OFF_TARGET",
      "side": null,
      "count": 3
    },
    {
      "id": "SHOT_OFF_TARGET:home:1",
      "tier": "common",
      "event": "SHOT_OFF_TARGET",
      "side": "home",
      "count": 1
    },
    {
      "id": "SHOT_OFF_TARGET:away:1",
      "tier": "common",
      "event": "SHOT_OFF_TARGET",
      "side": "away",
      "count": 1
    },
    {
      "id": "SHOT_ON_TARGET:any:1",
      "tier": "common",
      "event": "SHOT_ON_TARGET",
      "side": null,
      "count": 1
    },
    {
      "id": "SHOT_ON_TARGET:any:2",
      "tier": "common",
      "event": "SHOT_ON_TARGET",
      "side": null,
      "count": 2
    },
    {
      "id": "SHOT_ON_TARGET:home:1",
      "tier": "common",
      "event": "SHOT_ON_TARGET",
      "side": "home",
      "count": 1
    },
    {
      "id": "SHOT_ON_TARGET:away:1",
      "tier": "common",
      "event": "SHOT_ON_TARGET",
      "side": "away",
      "count": 1
    },
    {
      "id": "SUBSTITUTION:any:1",
      "tier": "common",
      "event": "SUBSTITUTION",
      "side": null,
      "count": 1
    },
    {
      "id": "SUBSTITUTION:home:1",
      "tier": "common",
      "event": "SUBSTITUTION",
      "side": "home",
      "count": 1
    },
    {
      "id": "SUBSTITUTION:away:1",
      "tier": "common",
      "event": "SUBSTITUTION",
      "side": "away",
      "count": 1
    },
    {
      "id": "OFFSIDE:any:1",
      "tier": "common",
      "event": "OFFSIDE",
      "side": null,
      "count": 1
    },
    {
      "id": "GOAL:any:1",
      "tier": "medium",
      "event": "GOAL",
      "side": null,
      "count": 1
    },
    {
      "id": "CARD:any:1",
      "tier": "medium",
      "event": "CARD",
      "side": null,
      "count": 1
    },
    {
      "id": "OFFSIDE:any:2",
      "tier": "medium",
      "event": "OFFSIDE",
      "side": null,
      "count": 2
    },
    {
      "id": "SUBSTITUTION:any:4",
      "tier": "medium",
      "event": "SUBSTITUTION",
      "side": null,
      "count": 4
    },
    {
      "id": "CORNER:any:5",
      "tier": "medium",
      "event": "CORNER",
      "side": null,
      "count": 5
    },
    {
      "id": "SHOT_ON_TARGET:any:4",
      "tier": "medium",
      "event": "SHOT_ON_TARGET",
      "side": null,
      "count": 4
    },
    {
      "id": "GOAL:home:1",
      "tier": "rare",
      "event": "GOAL",
      "side": "home",
      "count": 1
    },
    {
      "id": "GOAL:away:1",
      "tier": "rare",
      "event": "GOAL",
      "side": "away",
      "count": 1
    },
    {
      "id": "CARD:home:1",
      "tier": "rare",
      "event": "CARD",
      "side": "home",
      "count": 1
    },
    {
      "id": "CARD:away:1",
      "tier": "rare",
      "event": "CARD",
      "side": "away",
      "count": 1
    },
    {
      "id": "GOAL:any:2",
      "tier": "rare",
      "event": "GOAL",
      "side": null,
      "count": 2
    }
  ],
  "labelMaxLength": 40,
  "maxPoolCells": 64,
  "maxHouseCells": 16
};
