# Game catalog

Two categories. **Matchday** games need a selected live/upcoming fixture and its data. **General** games need only
season data for the six supported competitions, loaded at app start.

Competitions: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, UEFA Champions League.

**Status: the full catalog below is approved (2026-09-16).** All 21 games are in scope; `P1` ships first and the rest
land in Phases 5 and 6. Changes to this list after those phases start cost real rework, so amend here first.

`P1` marks the Phase-1 playable set.

---

## Matchday games

| id | Game | Concept | Data needed | Drink mechanic |
|---|---|---|---|---|
| `M1` | **Match Markets** `P1` | Betting-app-style slip between friends: final score, first scorer, anytime scorer, over/under goals, over/under corners, cards, both teams to score, HT result, winning margin, penalty awarded. Phase 1 ships the pre-kickoff slip only, locked at the first live event; in-play markets that open and settle independently during the match land in Phase 5 (see `docs/PLAN.md`). | Fixture, lineups, live events, match stats | Each lost market = sips; worst slip of the round downs it |
| `M2` | **Who's That Player?** `P1` | A fact about one of the 22 on the pitch; everyone guesses which player it is. | Lineups, player season stats, bio | Wrong = drink; last to answer correctly = drink |
| `M3` | **Shirt Number** `P1` | Guess a pitch player's squad number. Closest wins. | Lineups with shirt numbers | Drink = distance from the real number, capped |
| `M4` | **Your Man (draft)** | Every player is randomly drafted a starter and lives with them all match. | Lineups + live events per player | Your man fouls/misses/booked = you drink; scores/assists = everyone else drinks |
| `M5` | **Event Roulette** | Each player is dealt a live match event the feed actually reports (corner, offside, foul, card, substitution, shot on target, shot off target; goals opt-in — no throw-ins or goal kicks), distinct while the kinds last. A spin lasts N match minutes (default 10) from when the round opens, or until full time; deals are public, no input needed. | Live event feed | Each time your event fires, you drink — or everyone else does (host toggle); caps apply |
| `M6` | **Match Bingo** | A 3×3 (or 4×4) card per player of cells like "3 corners", "shot on target by <team>", "a card", auto-ticked from the live feed from the moment the round opens (5×5 is not completable on a real match's events). Cards are public; the round ends at the first full house or full time. | Live event feed | Each completed line (row, column, diagonal): everyone else drinks, once per line; full house: the table downs it |
| `M7` | **Minute Sniper** | Pick the exact minute of the next goal. Rounds open any time; picks (a minute after the current match minute, up to 90) close after a pick window, and the round settles on the next regulation goal — own goals and scored penalties included — after it opened. Stoppage goals count as 45 / 90. No goal before full time settles against 90; a round opened after full time is void. | Live goal events with minutes | Closest wins, furthest from it drinks (non-pickers drink a roll once the pick window has closed) |
| `M8` | **Stat Duel** | Each player picks a pitch player; head-to-head on shots / passes / tackles / duels at full time. | Live per-player match stats | Loser of each duel drinks; bracket to a final |
| `M9` | **Flash Rounds** | 20-second questions pushed at live moments: "will this corner produce a shot on target?", "will this free kick hit the target?" | Live events with low latency | Wrong or too slow = drink |
| `M10` | **Lineup Recall** | Before kickoff, name the starting XI from memory, against the clock. One round per team (home and away XIs are two rounds); names are typed free text, matched forgivingly (accents, surnames, small typos), at most one name per starter. | Lineups (confirmed) | One sip per player missed (not answering misses all eleven) |

## General games

| id | Game | Concept | Data needed |
|---|---|---|---|
| `G1` | **Guess the Player** `P1` | Progressive clues, order varies each round (nationality/position/age first, career/shirt number last); options are chosen so each clue rules some out. Guess earlier, score more. | Player bios + squads |
| `G6` | **Trivia Rush** `P1` | Rapid-fire multiple choice per league, Kahoot-style speed scoring. | Season stats, tables, squads |
| `G2` | **Higher or Lower** | Two players compared on goals, assists, appearances, age, height, or market value. | Season stats |
| `G3` | **Career Path** | Club sequence revealed one club at a time; name the player. | Career history |
| `G4` | **Name the Top 10** | Name the top scorers/assisters of a league season against the clock. | Season leaderboards |
| `G5` | **Odd One Out** | Four players, three share a hidden trait. | Squads + stats |
| `G7` | **Guess the Number** | A player and a stat are shown (season goals, appearances, assists, minutes, age, height, shirt number); everyone guesses the value, closest wins. Replaces Price Is Right, because no free source has market values. | Season stats (a player's bio fields ride along with their season-stat row; there is no separate bio requirement) |
| `G8` | **Teammate Chain** | Name someone who played with X; chain continues until someone fails. | Historical squads |
| `G9` | **Two Truths & a Lie** | Three "facts" about a player; spot the fabricated one. | Player stats (lie generated from a plausible distractor) |
| `G10` | **Most Likely To** | Social voting with football flavour, no data required. | none |
| `G11` | **Spin the Ball** | Pure-chance filler wheel between matches. | none |

## Scoring and penalty model

- Points: correctness base + speed bonus (decaying within the answer window) + streak multiplier.
- Penalties are engine-level `PenaltyEvent`s: `{ target: self | others | everyone, sips, reason }`, rendered into
  alcohol-explicit copy by the client's single `drinkCopy` module.
- Per-round and per-session sip caps protect against a runaway round.
- Every game contributes to one cumulative session leaderboard plus a session drink tally.
