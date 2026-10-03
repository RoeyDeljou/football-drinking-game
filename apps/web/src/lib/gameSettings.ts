/**
 * Pure helpers for the pre-game settings editor: what config to send, what changed from the
 * defaults (for the lobby summary), and readable INVALID_CONFIG text. The engine still validates
 * everything; nothing here decides a rule.
 */

import { gameConfigSpecFor, type GameConfigSpec } from './gameConfigSpecs';
import { fieldLabel, unitLabel, displayValue, optionLabel } from './gameSettingsCopy';

export type SettingsMode = 'default' | 'custom';

export interface SettingsState {
  readonly mode: SettingsMode;
  /** Only the keys the host changed. Optional keys appear here only when used. */
  readonly edits: Readonly<Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: SettingsState = { mode: 'default', edits: {} };

/** `SELECT_GAME.config`: `null` in Default mode (or for a game without settings), else defaults + edits. */
export const configFor = (moduleId: string, state: SettingsState): Record<string, unknown> | null => {
  const spec = gameConfigSpecFor(moduleId);
  if (spec === null || state.mode === 'default') return null;
  return { ...spec.defaults, ...state.edits };
};

/** Current value of a field: the host's edit, else the default. */
export const valueOf = (spec: GameConfigSpec, state: SettingsState, key: string): unknown =>
  key in state.edits ? state.edits[key] : spec.defaults[key];

export const withEdit = (state: SettingsState, key: string, value: unknown): SettingsState => {
  const edits = { ...state.edits };
  if (value === undefined) delete edits[key];
  else edits[key] = value;
  return { ...state, edits };
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * One line naming what differs from the defaults, e.g. "Line 3 sips · 12 custom cells · 2 house cells".
 * `null` when the config is absent or equal to the defaults.
 */
export const settingsSummary = (moduleId: string, config: unknown): string | null => {
  const spec = gameConfigSpecFor(moduleId);
  if (spec === null || typeof config !== 'object' || config === null) return null;
  const record = config as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of spec.fields) {
    const value = record[field.key];
    if (value === undefined || same(value, spec.defaults[field.key])) continue;
    switch (field.type) {
      case 'integer':
        parts.push(`${fieldLabel(field.key)} ${displayValue(field.unit, Number(value))}${field.unit === 'count' ? '' : ` ${unitLabel(field.unit, Number(value))}`}`.trim());
        break;
      case 'boolean':
        parts.push(`${fieldLabel(field.key)}: ${value === true ? 'on' : 'off'}`);
        break;
      case 'choice':
        parts.push(optionLabel(field.key, value as string | number));
        break;
      case 'multiChoice':
        parts.push(`${fieldLabel(field.key)}: ${(value as readonly string[]).length} chosen`);
        break;
      case 'labelOverrides':
        parts.push('renamed events');
        break;
      case 'textList':
        parts.push(`${(value as readonly unknown[]).length} house ${(value as readonly unknown[]).length === 1 ? 'cell' : 'cells'}`);
        break;
      case 'bingoCellPool':
        parts.push(`${(value as readonly unknown[]).length} custom cells`);
        break;
      default:
        break;
    }
  }
  return parts.length === 0 ? null : parts.join(' · ');
};

/**
 * `INVALID_CONFIG` detail is the engine's `path: message` issues joined with `; `. Make that readable:
 * "Bingo cells: a 3x3 card needs at least 7 pool cells, got 3".
 */
export const invalidConfigMessage = (detail: string | null): string => {
  const base = 'Those settings aren’t valid';
  if (detail === null || detail.trim().length === 0) return `${base}.`;
  const issues = detail
    .split(';')
    .map((issue) => issue.trim())
    .filter((issue) => issue.length > 0)
    .map((issue) => {
      const split = issue.indexOf(':');
      if (split === -1) return issue;
      const path = issue.slice(0, split).trim();
      const message = issue.slice(split + 1).trim();
      const root = path.split(/[.[\]]/)[0] ?? path;
      return `${fieldLabel(root)}: ${message}`;
    });
  return `${base} — ${issues.join('; ')}`;
};
