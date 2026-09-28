/**
 * The single competitions config map.
 *
 * Every provider id (API-Football league id, season number) lives here and nowhere else. Call sites resolve a
 * competition through `competitionConfig*` helpers and never spell a provider id inline.
 */

import type { Competition, CompetitionCode, CompetitionId, SeasonId } from './domain.js';
import { asCompetitionId, asSeasonId } from './domain.js';

export interface CompetitionConfig {
  /** Stable internal code used by the engine and the UI. */
  readonly code: CompetitionCode;
  /** Stable internal id (a slug). Never a provider id. */
  readonly id: CompetitionId;
  readonly name: string;
  readonly shortName: string;
  readonly country: string;
  readonly logoUrl: string | null;
  /** API-Football v3 league id. Only the API-Football adapter reads this. */
  readonly apiFootballLeagueId: number;
  /**
   * ESPN public site API league slug (e.g. `eng.1`) — the primary/first slug for this competition. Only the ESPN
   * adapter reads this. For every competition except National Teams this is the *only* slug; call sites that only
   * need "a" slug (a log line, a cache key prefix) can keep reading this field directly.
   */
  readonly espnSlug: string;
  /**
   * Extra ESPN slugs that also belong to this competition, beyond `espnSlug`. National-team football has no single
   * ESPN slug — ESPN splits it across separate feeds per tournament/qualifying zone (friendlies, Nations League,
   * World Cup qualifying per confederation, etc.) — so `NATIONAL_TEAMS` is the only competition that sets this.
   * Never read this directly; call `allEspnSlugs(config)` instead, so multi-slug aggregation stays centralized.
   */
  readonly espnAdditionalSlugs?: readonly string[];
  /** The season the app is currently serving, as a start year (API-Football and ESPN both number it this way). */
  readonly currentSeasonYear: number;
  /** Human season label, e.g. `2026/27`. */
  readonly currentSeason: SeasonId;
  /** Domestic leagues have no rounds worth showing; cups do. */
  readonly isCup: boolean;
}

const config = (
  code: CompetitionCode,
  slug: string,
  name: string,
  shortName: string,
  country: string,
  apiFootballLeagueId: number,
  espnSlug: string,
  isCup: boolean,
  espnAdditionalSlugs?: readonly string[],
): CompetitionConfig => ({
  code,
  id: asCompetitionId(slug),
  name,
  shortName,
  country,
  logoUrl: `https://media.api-sports.io/football/leagues/${String(apiFootballLeagueId)}.png`,
  apiFootballLeagueId,
  espnSlug,
  ...(espnAdditionalSlugs === undefined ? {} : { espnAdditionalSlugs }),
  currentSeasonYear: CURRENT_SEASON_YEAR,
  currentSeason: asSeasonId(seasonLabel(CURRENT_SEASON_YEAR)),
  isCup,
});

/**
 * Every ESPN slug that belongs to a competition: its primary `espnSlug` plus any `espnAdditionalSlugs`. Use this
 * everywhere a competition's fixtures/teams/squads are fetched from ESPN, instead of reading `config.espnSlug`
 * directly, so multi-slug aggregation (currently only National Teams) stays centralized in one place.
 */
export function allEspnSlugs(config: CompetitionConfig): readonly string[] {
  return [config.espnSlug, ...(config.espnAdditionalSlugs ?? [])];
}

/** Season the recorded dataset and the default live configuration target. */
export const CURRENT_SEASON_YEAR = 2026;

/** `2025` → `2025/26`. */
export function seasonLabel(startYear: number): string {
  const end = (startYear + 1) % 100;
  return `${String(startYear)}/${end.toString().padStart(2, '0')}`;
}

/** `2025/26` → `2025`. Returns null for anything that is not a season label. */
export function seasonStartYear(season: SeasonId | string): number | null {
  const match = /^(\d{4})/.exec(season);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  const year = Number.parseInt(raw, 10);
  return Number.isNaN(year) ? null : year;
}

export const COMPETITIONS: Readonly<Record<CompetitionCode, CompetitionConfig>> = {
  PREMIER_LEAGUE: config('PREMIER_LEAGUE', 'premier-league', 'Premier League', 'PL', 'England', 39, 'eng.1', false),
  LA_LIGA: config('LA_LIGA', 'la-liga', 'La Liga', 'LAL', 'Spain', 140, 'esp.1', false),
  SERIE_A: config('SERIE_A', 'serie-a', 'Serie A', 'SA', 'Italy', 135, 'ita.1', false),
  BUNDESLIGA: config('BUNDESLIGA', 'bundesliga', 'Bundesliga', 'BL1', 'Germany', 78, 'ger.1', false),
  LIGUE_1: config('LIGUE_1', 'ligue-1', 'Ligue 1', 'FL1', 'France', 61, 'fra.1', false),
  CHAMPIONS_LEAGUE: config(
    'CHAMPIONS_LEAGUE',
    'champions-league',
    'UEFA Champions League',
    'UCL',
    'Europe',
    2,
    'uefa.champions',
    true,
  ),
  // National-team football has no single ESPN slug: ESPN splits it across separate feeds per
  // tournament/qualifying zone. `espnSlug` (first below) is the primary/most-consistently-populated one
  // (international friendlies); the rest cover the Nations League, World Cup qualifying per confederation, and the
  // major dormant-between-windows tournament feeds (Euro, Euro qualifying, Copa América, Gold Cup, World Cup
  // itself). `allEspnSlugs()` is the only sanctioned way to read the full set.
  //
  // 10 is API-Football's "Friendlies" league id, used only as a best-effort placeholder: the API-Football adapter
  // is not the live provider today, has no multi-id aggregation, and this id covers only one slice (friendlies) of
  // what this competition represents on ESPN. It is deliberately inert rather than wrong: a stale/unverified id
  // just returns an empty/irrelevant result set from that adapter, never a crash.
  NATIONAL_TEAMS: config(
    'NATIONAL_TEAMS',
    'national-teams',
    'National Teams',
    'INTL',
    'International',
    10,
    'fifa.friendly',
    true,
    ['uefa.nations', 'fifa.worldq.uefa', 'fifa.worldq.conmebol', 'fifa.worldq.afc', 'fifa.worldq.caf', 'fifa.worldq.concacaf', 'concacaf.gold', 'uefa.euroq', 'uefa.euro', 'conmebol.america', 'fifa.world'],
  ),
};

// Champions League leads: it's the one competition every host recognizes regardless of which
// domestic league they follow, so it's the default first option in the league picker. National Teams goes right
// after it: like the Champions League it cuts across every host's domestic-league allegiance (anyone can have an
// opinion on international football), but unlike it, it is not guaranteed to have live matches on a given weekend
// (only during FIFA windows), so it sits just behind rather than displacing the Champions League.
export const COMPETITION_CODES: readonly CompetitionCode[] = [
  'CHAMPIONS_LEAGUE',
  'NATIONAL_TEAMS',
  'PREMIER_LEAGUE',
  'LA_LIGA',
  'SERIE_A',
  'BUNDESLIGA',
  'LIGUE_1',
];

export const COMPETITION_CONFIGS: readonly CompetitionConfig[] = COMPETITION_CODES.map(
  (code) => COMPETITIONS[code],
);

export function competitionConfigByCode(code: CompetitionCode): CompetitionConfig {
  return COMPETITIONS[code];
}

export function competitionConfigById(id: CompetitionId | string): CompetitionConfig | null {
  return COMPETITION_CONFIGS.find((entry) => entry.id === id) ?? null;
}

export function competitionConfigByEspnSlug(slug: string): CompetitionConfig | null {
  return COMPETITION_CONFIGS.find((entry) => allEspnSlugs(entry).includes(slug)) ?? null;
}

export function competitionConfigByApiFootballId(leagueId: number): CompetitionConfig | null {
  return COMPETITION_CONFIGS.find((entry) => entry.apiFootballLeagueId === leagueId) ?? null;
}

/** Is this competition one the app supports at all? */
export function isSupportedCompetitionId(id: string): boolean {
  return competitionConfigById(id) !== null;
}

/** Project a config row into the normalized domain `Competition`. */
export function toCompetition(entry: CompetitionConfig): Competition {
  return {
    id: entry.id,
    code: entry.code,
    name: entry.name,
    country: entry.country,
    logoUrl: entry.logoUrl,
    currentSeason: entry.currentSeason,
  };
}

export function allCompetitions(): readonly Competition[] {
  return COMPETITION_CONFIGS.map(toCompetition);
}
