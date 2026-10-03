'use client';

/**
 * The host's pre-game settings for one game, built from the engine's field specs. Default mode is
 * preselected and sends no config; Custom shows every editable field. Wherever a game is picked (the
 * host screen, the lobby picker, the intermission picker) this is the same component.
 */

import { gameConfigSpecFor, type ConfigFieldSpec } from '@/lib/gameConfigSpecs';
import { displayValue, fieldLabel, optionLabel, unitLabel } from '@/lib/gameSettingsCopy';
import { valueOf, withEdit, type SettingsState } from '@/lib/gameSettings';
import { eventLabel, type LiveEventKind } from '@/lib/liveEventCopy';
import { BingoEditor } from './BingoEditor';
import { Chip, Segmented, Stepper, Toggle } from './SettingsControls';
import { Eyebrow } from './ui';

export interface TeamNames {
  readonly home: string;
  readonly away: string;
}

const Row = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element => (
  <div className="flex flex-col gap-2">
    <p className="t-sm max-w-full font-semibold text-fg-muted">{label}</p>
    {children}
  </div>
);

export const GameSettingsEditor = ({
  moduleId,
  state,
  onChange,
  teams,
}: {
  readonly moduleId: string;
  readonly state: SettingsState;
  readonly onChange: (state: SettingsState) => void;
  readonly teams: TeamNames;
}): React.JSX.Element | null => {
  const spec = gameConfigSpecFor(moduleId);
  if (spec === null) return null;

  const renderField = (field: ConfigFieldSpec): React.JSX.Element | null => {
    // Match Bingo's house-cells-per-card count sits with the house cells, in the Bingo editor.
    if (field.key === 'housePerCard') return null;
    const value = valueOf(spec, state, field.key);
    switch (field.type) {
      case 'integer': {
        const current = typeof value === 'number' ? value : field.min;
        return (
          <Row key={field.key} label={fieldLabel(field.key)}>
            <Stepper
              label={fieldLabel(field.key)}
              value={current}
              min={field.min}
              max={field.max}
              step={field.step}
              display={displayValue(field.unit, current)}
              suffix={unitLabel(field.unit, displayValue(field.unit, current))}
              onChange={(next) => onChange(withEdit(state, field.key, next))}
            />
          </Row>
        );
      }
      case 'boolean':
        return (
          <div key={field.key} className="flex flex-wrap items-center justify-between gap-3">
            <p className="t-body max-w-full flex-1 basis-40 font-semibold">{fieldLabel(field.key)}</p>
            <Toggle label={fieldLabel(field.key)} checked={value === true} onChange={(next) => onChange(withEdit(state, field.key, next))} />
          </div>
        );
      case 'choice':
        return (
          <Row key={field.key} label={fieldLabel(field.key)}>
            <Segmented
              label={fieldLabel(field.key)}
              options={field.options}
              value={value as string | number}
              labelOf={(option) => optionLabel(field.key, option)}
              onChange={(next) => onChange(withEdit(state, field.key, next))}
            />
          </Row>
        );
      case 'multiChoice': {
        const chosen = Array.isArray(value) ? (value as readonly string[]) : field.options;
        return (
          <Row key={field.key} label={`${fieldLabel(field.key)} (${chosen.length} of ${field.options.length})`}>
            <div className="flex flex-wrap gap-2" role="group" aria-label={fieldLabel(field.key)}>
              {field.options.map((option) => {
                const on = chosen.includes(option);
                return (
                  <Chip
                    key={option}
                    label={optionLabel(field.key, option)}
                    pressed={on}
                    disabled={on && chosen.length <= field.minItems}
                    onClick={() =>
                      onChange(
                        withEdit(
                          state,
                          field.key,
                          field.options.filter((entry) => (entry === option ? !on : chosen.includes(entry))),
                        ),
                      )
                    }
                  />
                );
              })}
            </div>
          </Row>
        );
      }
      case 'labelOverrides': {
        const labels = (typeof value === 'object' && value !== null ? value : {}) as Record<string, string>;
        const set = (option: string, text: string): void => {
          const next = { ...labels };
          if (text.trim().length === 0) delete next[option];
          else next[option] = text;
          onChange(withEdit(state, field.key, Object.keys(next).length === 0 ? undefined : next));
        };
        return (
          <Row key={field.key} label={`${fieldLabel(field.key)} (optional)`}>
            <div className="split-cols gap-2 [--split-min:14rem]">
              {field.options.map((option) => (
                <label key={option} className="flex flex-col gap-1">
                  <span className="t-xs text-fg-subtle">{eventLabel(option as LiveEventKind)}</span>
                  <input
                    className="field-input"
                    value={labels[option] ?? ''}
                    maxLength={field.maxLength}
                    placeholder={eventLabel(option as LiveEventKind)}
                    autoComplete="off"
                    onChange={(event) => set(option, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </Row>
        );
      }
      default:
        return null; // bingoCellPool, textList and housePerCard are the Bingo editor's.
    }
  };

  const isBingo = spec.fields.some((field) => field.type === 'bingoCellPool');
  const custom = state.mode === 'custom';

  return (
    <section className="flex flex-col gap-3" aria-label="Game settings">
      <Eyebrow>Settings</Eyebrow>
      <Segmented
        label="Settings mode"
        options={['default', 'custom'] as const}
        value={state.mode}
        labelOf={(mode) => (mode === 'default' ? 'Default rules' : 'Custom')}
        onChange={(mode) => onChange({ ...state, mode })}
      />
      {custom ? (
        <div className="flex flex-col gap-4 rounded-md bg-hover p-3">
          {spec.fields.map(renderField)}
          {isBingo ? <BingoEditor spec={spec} state={state} onChange={onChange} teams={teams} /> : null}
        </div>
      ) : (
        <p className="t-sm text-fg-muted">Standard rules and sip amounts. Switch to Custom to change them.</p>
      )}
    </section>
  );
};
