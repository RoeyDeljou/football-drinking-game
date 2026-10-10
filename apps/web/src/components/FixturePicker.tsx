'use client';

/**
 * The host's multi-match picker: live (and upcoming) fixtures grouped by competition, any number ticked,
 * mixed across competitions. Competitions with live matches come first and start expanded; the rest load
 * their list when opened. One ticked match = a single-match room, several = a rotation room.
 */

import { useEffect, useState } from 'react';
import type { ApiResult, Competition, FixtureSummary } from '@/lib/api';
import { listCompetitionFixtures } from '@/lib/api';
import { competitionMonogram } from '@/lib/competitionMonogram';
import {
  clearGroup,
  groupFullyPicked,
  isPicked,
  listableFixtures,
  mergeFixtures,
  MAX_FIXTURES,
  orderCompetitions,
  selectAll,
  selectionSummary,
  toggleFixture,
  type FixtureSelection,
  type PickedFixture,
} from '@/lib/fixtureSelection';
import { formatKickoffLocal, isFixtureLive, kickoffCountdown, liveBadgeLabel } from '@/lib/matchdayPicker';
import { Banner, BigButton, Eyebrow } from './ui';

type Loaded = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly fixtures: readonly FixtureSummary[] };

export const FixturePicker = ({
  competitions,
  liveFixtures,
  selection,
  onChange,
  now,
}: {
  readonly competitions: readonly Competition[];
  /** Live fixtures the background sweep already found, from every competition. */
  readonly liveFixtures: readonly FixtureSummary[];
  readonly selection: FixtureSelection;
  readonly onChange: (selection: FixtureSelection) => void;
  readonly now: number;
}): React.JSX.Element => {
  const groups = orderCompetitions(competitions, liveFixtures);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [autoOpened, setAutoOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [lists, setLists] = useState<Readonly<Record<string, Loaded>>>({});

  const load = (competitionId: string): void => {
    setLists((previous) => ({ ...previous, [competitionId]: { status: 'loading' } }));
    void listCompetitionFixtures(competitionId).then((result: ApiResult<{ fixtures: readonly FixtureSummary[] }>) => {
      setLists((previous) => ({
        ...previous,
        [competitionId]: result.ok ? { status: 'ready', fixtures: result.value.fixtures } : { status: 'error', message: result.message },
      }));
    });
  };

  // Competitions with live matches open themselves once (and stay under the host's control after that).
  useEffect(() => {
    const fresh = groups.filter((group) => group.liveCount > 0 && !autoOpened.has(group.competition.id)).map((group) => group.competition.id);
    if (fresh.length === 0) return;
    setAutoOpened((previous) => new Set([...previous, ...fresh]));
    setExpanded((previous) => new Set([...previous, ...fresh]));
    // groups is derived from the props below; the opened set is what guards re-runs.
  }, [liveFixtures, competitions]);

  // Every open group needs its full list (upcoming matches), fetched once.
  useEffect(() => {
    for (const id of expanded) if (lists[id] === undefined) load(id);
    // `load` only sets state; `lists` guards against refetching.
  }, [expanded]);

  const toggleOpen = (competitionId: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(competitionId)) next.delete(competitionId);
      else next.add(competitionId);
      return next;
    });

  const anyUpcoming = (fixtures: readonly FixtureSummary[]): boolean => fixtures.some((fixture) => !isFixtureLive(fixture));

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-[max(0.5rem,env(safe-area-inset-top))] z-20 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border-2 border-border-strong bg-bg-raised px-3 py-2 shadow-sheet">
        <p role="status" aria-live="polite" className="t-body max-w-full flex-1 basis-48 font-semibold">
          {selectionSummary(selection)}
        </p>
        {selection.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="pressable min-h-11 rounded-md border-2 border-border-strong px-4 text-sm font-bold"
          >
            Clear all
          </button>
        ) : null}
      </div>
      <p className="t-xs text-fg-subtle">
        Tick one match for a single-match room, or several (even across leagues) and the rounds rotate between them. Up to {MAX_FIXTURES}.
      </p>

      {groups.map(({ competition, liveCount }) => {
        const open = expanded.has(competition.id);
        const loaded = lists[competition.id];
        const sweepFixtures = liveFixtures.filter((fixture) => fixture.competitionId === competition.id);
        const fixtures = listableFixtures(mergeFixtures(sweepFixtures, loaded?.status === 'ready' ? loaded.fixtures : []));
        const picks: PickedFixture[] = fixtures.map((fixture) => ({ fixture, competitionName: competition.name }));
        const pickedHere = selection.filter((entry) => entry.fixture.competitionId === competition.id).length;
        const panelId = `fixtures-${competition.id}`;
        return (
          <section key={competition.id} className="rounded-md border-2 border-border bg-card">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => toggleOpen(competition.id)}
              className="pressable flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg-sunken text-sm font-bold tracking-wide text-fg-muted"
                aria-hidden
              >
                {competitionMonogram(competition.name)}
              </span>
              <span className="max-w-full flex-1 basis-32 font-bold">{competition.name}</span>
              <span className="flex flex-wrap items-center gap-2">
                {liveCount > 0 ? (
                  <span className="whitespace-nowrap rounded-full bg-live/20 px-2 py-0.5 text-xs font-bold text-live">{liveCount} live</span>
                ) : null}
                {pickedHere > 0 ? (
                  <span className="whitespace-nowrap rounded-full bg-accent/20 px-2 py-0.5 text-xs font-bold text-accent">{pickedHere} ticked</span>
                ) : null}
                <span aria-hidden className="text-fg-muted">
                  {open ? '▴' : '▾'}
                </span>
              </span>
            </button>

            {open ? (
              <div id={panelId} className="flex flex-col gap-2 border-t border-border px-3 py-3">
                {loaded?.status === 'loading' && fixtures.length === 0 ? (
                  <p role="status" aria-live="polite" className="t-body text-fg-muted">
                    Loading fixtures…
                  </p>
                ) : null}
                {loaded?.status === 'error' ? (
                  <div className="flex flex-col gap-2">
                    <Banner tone="error">{loaded.message}</Banner>
                    <BigButton variant="secondary" onClick={() => load(competition.id)}>
                      Try again
                    </BigButton>
                  </div>
                ) : null}
                {loaded?.status === 'ready' && fixtures.length === 0 ? <Banner>No live or upcoming matches right now.</Banner> : null}

                {fixtures.length > 0 ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Eyebrow>{fixtures.length} {fixtures.length === 1 ? 'match' : 'matches'}</Eyebrow>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => onChange(selectAll(selection, picks))}
                          disabled={groupFullyPicked(selection, picks)}
                          className="pressable min-h-11 rounded-md border-2 border-accent px-4 text-sm font-bold text-accent disabled:opacity-40"
                        >
                          All in {competition.name}
                        </button>
                        {pickedHere > 0 ? (
                          <button
                            type="button"
                            onClick={() => onChange(clearGroup(selection, competition.id))}
                            className="pressable min-h-11 rounded-md border-2 border-border-strong px-4 text-sm font-bold text-fg-muted"
                          >
                            None
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <ul className="flex flex-col gap-2" role="group" aria-label={`${competition.name} matches`}>
                      {fixtures.map((fixture) => {
                        const live = isFixtureLive(fixture);
                        const badge = liveBadgeLabel(fixture);
                        const checked = isPicked(selection, fixture.fixtureId);
                        const full = !checked && selection.length >= MAX_FIXTURES;
                        return (
                          <li key={fixture.fixtureId}>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              disabled={full}
                              onClick={() => onChange(toggleFixture(selection, { fixture, competitionName: competition.name }))}
                              className={`tap-target pressable flex w-full items-center gap-3 rounded-md border-2 px-3 py-2 text-left disabled:opacity-50 ${
                                checked ? 'border-accent bg-selected' : 'border-border bg-card'
                              }`}
                            >
                              <span
                                aria-hidden
                                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 text-base font-black ${
                                  checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong'
                                }`}
                              >
                                {checked ? '✓' : ''}
                              </span>
                              <span className="flex max-w-full flex-1 flex-col gap-0.5">
                                <span className="max-w-full font-bold text-[min(1rem,5vw)] sm:text-base">
                                  {fixture.homeTeam.name} vs {fixture.awayTeam.name}
                                </span>
                                {!live ? (
                                  <span className="t-xs text-fg-muted">
                                    {formatKickoffLocal(fixture.kickoff)} · {kickoffCountdown(fixture.kickoff, now)}
                                  </span>
                                ) : null}
                              </span>
                              {live && badge !== null ? (
                                <span className="shrink-0 whitespace-nowrap rounded-full bg-live/20 px-2 py-0.5 text-xs font-bold text-live">{badge}</span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {anyUpcoming(fixtures) ? (
                      <p className="t-xs text-fg-subtle">
                        Lineups are published about an hour before kickoff, so games for an upcoming match won&apos;t be selectable until then.
                        Tick a live match for a game you can start now.
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};
