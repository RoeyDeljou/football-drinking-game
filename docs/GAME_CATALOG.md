# Game catalog

Two categories. **Matchday** games need a selected live/upcoming fixture and its data. **General** games need only
season data for the six supported competitions, loaded at app start.

Competitions: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, UEFA Champions League.

`P1` marks the Phase-1 playable set.

---

## Matchday games

| id | Game | Concept | Data needed | Drink mechanic |
|---|---|---|---|---|
| `M1` | **Match Markets** `P1` | Betting-app-style slip between friends: final score, first scorer, anytime scorer, over/under goals, over/under corners, cards, both teams to score, HT result, winning margin, penalty awarded. Pre-kickoff slip plus in-play markets. | Fixture, lineups, live events, match stats | Each lost market = sips; worst slip of the round downs it |
| `M2` | **Who's That Player?** `P1` | A fact about one of the 22 on the pitch; everyone guesses which player it is. | Lineups, player season stats, bio | Wrong = drink; last to answer correctly = drink |
| `M3` | **Shirt Number** `P1` | Guess a pitch player's squad number. Closest wins. | Lineups with shirt numbers | Drink = distance from the real number, capped |
| `M4` | **Your Man (draft)** | Every player is randomly drafted a starter and lives with them all match. | Lineups + live events per player | Your man fouls/misses/booked = you drink; scores/assists = everyone else drinks |
| `M5` | **Event Roulette** | Each player is dealt a live match event (corner, offside, throw-in, VAR check, substitution, goal kick). | Live event feed | The event fires = the owner drinks, or everyone else (host toggle) |
| `M6` | **Match Bingo** | A 5×5 card of match events per player, auto-ticked from the live feed. | Live event feed | Line = everyone drinks; full house = table downs |
| `M7` | **Minute Sniper** | Pick the exact minute of the next goal. | Live goal events with minutes | Closest wins, furthest from it drinks |
| `M8` | **Stat Duel** | Each player picks a pitch player; head-to-head on shots / passes / tackles / duels at full time. | Live per-player match stats | Loser of each duel drinks; bracket to a final |
| `M9` | **Flash Rounds** | 20-second questions pushed at live moments: "will this corner produce a shot on target?", "will this free kick hit the target?" | Live events with low latency | Wrong or too slow = drink |
| `M10` | **Lineup Recall** | Before kickoff, name the starting XI from memory, against the clock. | Lineups | One sip per player missed |

## General games

| id | Game | Concept | Data needed |
|---|---|---|---|
| `G1` | **Guess the Player** `P1` | Progressive clues — nationality → position → age → club history → shirt number. Guess earlier, score more. | Player bios + squads |
| `G6` | **Trivia Rush** `P1` | Rapid-fire multiple choice per league, Kahoot-style speed scoring. | Season stats, tables, squads |
| `G2` | **Higher or Lower** | Two players compared on goals, assists, appearances, age, height, or market value. | Season stats |
| `G3` | **Career Path** | Club sequence revealed one club at a time; name the player. | Career history |
| `G4` | **Name the Top 10** | Name the top scorers/assisters of a league season against the clock. | Season leaderboards |
| `G5` | **Odd One Out** | Four players, three share a hidden trait. | Squads + stats |
| `G7` | **Price Is Right** | Guess a transfer fee / market value; closest wins. | Transfer/value data |
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
