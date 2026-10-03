'use client';

/**
 * The in-room game chooser: `GameModePicker` (Shuffle game / Select Mini Game) wired to `SELECT_GAME`
 * plus the server-truth pending states (waking server / loading data / stalled + retry) and the Start
 * button. Used by the lobby (host) and the intermission "play another game" step.
 *
 * Lobby extras: `autoSelectModuleId` is the game the host already chose on /host — dispatched once
 * through the same `onSelectGame` path when connected, with all the usual pending feedback; if the
 * server rejects it the picker stays open (never a dead end) so the host can pick something else.
 * With `collapsible`, a confirmed selection collapses to a summary + "Change".
 */

import type { ClientRoom } from '@/lib/currentFixture';
import { useEffect, useRef, useState } from 'react';
import { GAME_CATALOG } from '@/games/catalog';
import { choiceFromModuleId, choiceLabel, resolveModuleId, type GameCategory, type ModeChoice } from '@/lib/gameMode';
import { decideInitialSelection } from '@/lib/initialSelection';
import { notConnectedMessage, PICKER_COPY, pendingMessage } from '@/lib/pickerCopy';
import { useRoom } from '@/lib/room-context';
import {
  beginPending,
  pendingPhase,
  resolvePending,
  retryPending,
  type PendingState,
} from '@/lib/selectionPending';
import { useNow } from '@/lib/useNow';
import { configFor, DEFAULT_SETTINGS, settingsSummary, type SettingsState } from '@/lib/gameSettings';
import { gameConfigSpecFor } from '@/lib/gameConfigSpecs';
import { GameModePicker } from './GameModePicker';
import { GameSettingsEditor } from './GameSettingsEditor';
import { Banner, BigButton, Card, Eyebrow } from './ui';

const CATEGORY_LABEL: Record<GameCategory, string> = { matchday: 'Matchday', general: 'General' };

export const GamePicker = ({
  room,
  category,
  onSelectGame,
  onStart,
  startLabel,
  startDisabled = false,
  autoSelectModuleId = null,
  autoSelectConfig = null,
  fixtureStatus = null,
  setupScope = null,
  onAutoSelectSettled,
  collapsible = false,
}: {
  readonly room: ClientRoom;
  readonly category: GameCategory | null;
  /** Sends `SELECT_GAME`. Returns `false` if it could not be sent (no seat / not connected). */
  readonly onSelectGame: (moduleId: string, config: Record<string, unknown> | null) => boolean;
  readonly onStart: () => void;
  readonly startLabel: string;
  readonly startDisabled?: boolean;
  /** The host's choice from the /host screen, dispatched once when connected (lobby only). */
  readonly autoSelectModuleId?: string | null;
  /** The host's custom settings from /host, sent with the auto-selected game. */
  readonly autoSelectConfig?: Record<string, unknown> | null;
  /** The matchday fixture's status, so finished matches hide the live-only games. */
  readonly fixtureStatus?: string | null;
  /** Shown in the setup summary between the category and the round count. */
  readonly setupScope?: string | null;
  /** Called once the server confirmed or rejected the auto-selected game (clears the stored choice). */
  readonly onAutoSelectSettled?: () => void;
  readonly collapsible?: boolean;
}): React.JSX.Element => {
  const { status, lastError, clearError } = useRoom();
  const now = useNow(500);
  const [pending, setPending] = useState<PendingState>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rejectedAutoSelect, setRejectedAutoSelect] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModeChoice>(() =>
    choiceFromModuleId(room.selection?.moduleId ?? autoSelectModuleId),
  );
  const autoDispatched = useRef(false);
  // Custom game settings for the game being picked. Default mode sends no config at all.
  const [settings, setSettings] = useState<SettingsState>(() =>
    autoSelectConfig === null ? DEFAULT_SETTINGS : { mode: 'custom', edits: autoSelectConfig },
  );
  const [appliedJson, setAppliedJson] = useState<string>(() => JSON.stringify(autoSelectConfig === null ? null : autoSelectConfig));

  const connected = status === 'connected';
  // The room's category, or what the chosen game implies while the room summary is still loading.
  // `null` means genuinely unknown yet: the picker shows a loading row rather than guessing a
  // category and flashing the wrong list of games.
  const effectiveCategory: GameCategory | null =
    category ??
    GAME_CATALOG.find((game) => game.id === (room.selection?.moduleId ?? autoSelectModuleId))?.category ??
    null;

  // Server truth stays authoritative: pending only ever clears because the server confirmed
  // (`room.selection` + a newer version), a room:error arrived, or the socket dropped.
  useEffect(() => {
    setPending((current) =>
      resolvePending(current, {
        selectionModuleId: room.selection?.moduleId ?? null,
        roomVersion: room.version,
        connected,
        errorToken: lastError,
      }),
    );
  }, [room.selection?.moduleId, room.version, connected, lastError]);

  const send = (moduleId: string, config: Record<string, unknown> | null = null): boolean => {
    if (!connected) return false;
    clearError();
    setEditing(false);
    const sent = onSelectGame(moduleId, config);
    setSendFailed(!sent);
    if (!sent) return false;
    setAppliedJson(JSON.stringify(config));
    setPending(beginPending({ moduleId, now: Date.now(), roomVersion: room.version, errorToken: lastError }));
    return true;
  };

  // The host's /host choice: dispatch once, then clear the stored choice when the server answered.
  useEffect(() => {
    if (autoSelectModuleId === null) {
      autoDispatched.current = false;
      return;
    }
    const action = decideInitialSelection({
      stored: autoSelectModuleId,
      isHost: room.you?.isHost ?? false,
      phase: room.phase,
      selectionModuleId: room.selection?.moduleId ?? null,
      connected,
      dispatched: autoDispatched.current,
    });
    if (action === 'dispatch') {
      autoDispatched.current = true;
      setRejectedAutoSelect(null);
      setChoice(choiceFromModuleId(autoSelectModuleId));
      if (!send(autoSelectModuleId, autoSelectConfig)) autoDispatched.current = false;
    } else if (action === 'clear') {
      autoDispatched.current = false;
      onAutoSelectSettled?.();
    } else if (autoDispatched.current && !connected) {
      // Dropped before the server answered: try again once reconnected (the stored choice stays).
      autoDispatched.current = false;
    } else if (autoDispatched.current && pending === null && room.selection === null) {
      // The server answered without selecting anything = rejected. The room-level error banner has
      // the reason; keep the picker open so the host can change the game inline.
      autoDispatched.current = false;
      setRejectedAutoSelect(autoSelectModuleId);
      setEditing(true);
      onAutoSelectSettled?.();
    }
    // `send` closes over the current room; the inputs that matter are listed explicitly.
  }, [autoSelectModuleId, connected, room.phase, room.selection?.moduleId, room.you?.isHost, pending]);

  const retry = (): void => {
    if (pending === null) return;
    const sent = onSelectGame(pending.moduleId, JSON.parse(appliedJson) as Record<string, unknown> | null);
    setSendFailed(!sent);
    if (sent) setPending(retryPending(pending, { now: Date.now(), roomVersion: room.version, errorToken: lastError }));
  };

  const onChoice = (next: ModeChoice): void => {
    setChoice(next);
    setRejectedAutoSelect(null);
    if (effectiveCategory === null) return;
    const moduleId = resolveModuleId(effectiveCategory, next);
    const previous = resolveModuleId(effectiveCategory, choice);
    // Settings belong to one game: picking another starts it on Default rules.
    if (moduleId !== previous) setSettings(DEFAULT_SETTINGS);
    if (moduleId !== null) send(moduleId, moduleId === previous ? configFor(moduleId, settings) : null);
  };

  const onSettings = (next: SettingsState): void => {
    setSettings(next);
    // Back to Default rules applies at once; Custom waits for an explicit Apply.
    if (next.mode === 'default' && settings.mode === 'custom' && choiceModuleId !== null) send(choiceModuleId, null);
  };

  const phase = pendingPhase(pending, now);
  const waitMessage = pendingMessage(phase);
  const connectionHint = notConnectedMessage(status) ?? (sendFailed ? notConnectedMessage('idle') : null);

  const selectedId = room.selection?.moduleId ?? null;
  // Start only when what the control shows is what the server holds, and nothing is in flight.
  const choiceModuleId = effectiveCategory === null ? null : resolveModuleId(effectiveCategory, choice);
  const inSync = selectedId !== null && choiceModuleId === selectedId;
  const showSummary = collapsible && selectedId !== null && pending === null && !editing;

  const spec = choiceModuleId === null ? null : gameConfigSpecFor(choiceModuleId);
  const currentConfig = choiceModuleId === null ? null : configFor(choiceModuleId, settings);
  const dirty = spec !== null && settings.mode === 'custom' && JSON.stringify(currentConfig) !== appliedJson;

  const startButton = (
    <BigButton disabled={pending !== null || !inSync || startDisabled || dirty} onClick={onStart}>
      {pending !== null
        ? PICKER_COPY.buttonPreparing
        : selectedId === null
          ? 'Choose a game to start'
          : !inSync
            ? 'Pick a mini game'
            : dirty
              ? 'Apply your settings first'
              : startLabel}
    </BigButton>
  );

  if (showSummary && selectedId !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-full flex-1 basis-40">
              <Eyebrow>
                {category === null
                  ? 'Your setup'
                  : [
                      CATEGORY_LABEL[category],
                      setupScope,
                      `${room.settings.roundsPerSession} ${room.settings.roundsPerSession === 1 ? 'round' : 'rounds'}`,
                    ]
                      .filter((part): part is string => part !== null && part.length > 0)
                      .join(' · ')}
              </Eyebrow>
              <p className="t-d1 mt-1">{choiceLabel(selectedId)}</p>
              {settingsSummary(selectedId, room.selection?.config) !== null ? (
                <p className="t-sm mt-1 max-w-full font-semibold text-accent">
                  Custom: {settingsSummary(selectedId, room.selection?.config)}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setChoice(choiceFromModuleId(selectedId));
                // Reopen on what the server holds: custom settings stay editable, default stays default.
                const held: SettingsState =
                  settingsSummary(selectedId, room.selection?.config) !== null
                    ? { mode: 'custom', edits: (room.selection?.config ?? {}) as Record<string, unknown> }
                    : DEFAULT_SETTINGS;
                setSettings(held);
                setAppliedJson(JSON.stringify(configFor(selectedId, held)));
                setEditing(true);
              }}
              className="tap-target pressable shrink-0 rounded-md border-2 border-border-strong px-4 text-sm font-bold"
            >
              Change
            </button>
          </div>
        </Card>
        {startButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Eyebrow className="mb-3">Pick a game</Eyebrow>
        {rejectedAutoSelect !== null ? (
          <div className="mb-3" role="alert">
            <Banner tone="warn">
              Couldn&apos;t set up {choiceLabel(rejectedAutoSelect)}. Pick another below, or try again.
            </Banner>
          </div>
        ) : null}
        {connectionHint !== null ? (
          <div className="mb-3">
            <Banner tone="warn">{connectionHint}</Banner>
          </div>
        ) : null}
        {effectiveCategory === null ? (
          <div role="status" aria-live="polite" className="t-body py-4 text-center text-fg-muted">
            Loading games…
          </div>
        ) : (
          <GameModePicker
            category={effectiveCategory}
            value={choice}
            onChange={onChoice}
            pendingModuleId={pending?.moduleId ?? null}
            disabled={!connected}
            fixtureStatus={fixtureStatus}
          />
        )}
        {spec !== null && choiceModuleId !== null && effectiveCategory !== null ? (
          <div className="mt-4">
            <GameSettingsEditor
              moduleId={choiceModuleId}
              state={settings}
              onChange={onSettings}
              teams={{ home: room.currentFixture?.homeTeam.name ?? 'Home', away: room.currentFixture?.awayTeam.name ?? 'Away' }}
            />
            {settings.mode === 'custom' ? (
              <BigButton className="mt-3" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !connected || pending !== null} onClick={() => send(choiceModuleId, currentConfig)}>
                {dirty ? 'Apply settings' : 'Settings applied'}
              </BigButton>
            ) : null}
          </div>
        ) : null}
        {waitMessage !== null ? (
          <div className="mt-3" role="status" aria-live="polite">
            <Banner tone={phase === 'stalled' ? 'warn' : 'info'}>{waitMessage}</Banner>
            {phase === 'stalled' ? (
              <BigButton className="mt-2" variant="secondary" onClick={retry}>
                {PICKER_COPY.retry}
              </BigButton>
            ) : null}
          </div>
        ) : null}
      </Card>
      {startButton}
    </div>
  );
};
