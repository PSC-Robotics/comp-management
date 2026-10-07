# Competition Management System

## Purpose

Deliver a web application for managing a robotics competition from team registration through league matches and double-elimination playoffs. The admin application is the control surface; published displays are read-only and can be opened directly or embedded elsewhere.

## Application layout

The authenticated dashboard uses a persistent left navigation with separate pages:

| Page | Responsibilities |
|---|---|
| Competitions | Create, select, review and permanently delete competition instances |
| Overview | Status, team/match/completion totals, live matches, next match and publish action |
| Teams | Add teams with unique three-letter codes; edit names; activate/deactivate teams; delete teams without recorded history |
| Challenges | Create competition-specific challenges and award their league points once per team |
| Schedule | Generate balanced league matches, schedule playoff heats and timed events; manage times, arena, teams, scoring and underfilled matches |
| Live control | Start, pause, resume, delay, finish and score matches; inspect team positions and underfilled status |
| League table | Review match points, challenge points, totals and scored-match counts; open the public JSON output |
| Arena | Set competition-wide position colours and inspect a match's team assignments and vacancies |
| Public displays | Configure named, slugged league, schedule, arena, timer and corner outputs; enable, disable, delete, copy direct URLs and copy iframe markup |
| Settings | Choose a competition theme and upload/remove the competition logo |
| Activity | Review recent administrative and system changes |

Pages use concise labels and controls. Competition identity and branding are configurable; the three included visual themes are Paper, Field and Night.
Competition and match data refresh automatically in the admin dashboard without a manual refresh control. Unsaved form edits are preserved while live updates arrive.

## Functional requirements

### Competition and teams

- An administrator creates a competition with a name, URL slug, timezone and match duration, then publishes it when its public views are ready.
- A team has a unique three-letter code, a display name and an active state.
- Team status cannot be changed after that team has been scheduled. Names remain editable.
- A team may be permanently deleted only before it has match, score, challenge or playoff history; otherwise it can be deactivated to preserve the record.
- A competition can be permanently deleted from the Competitions dashboard. Require typing its slug to confirm; its teams, matches, scores, score revisions, challenges and awards, brackets, settings and public displays are removed together. Keep an audit record of the deletion.

### League schedule

- A league match has four labelled arena positions. Each position has a team assignment or is vacant. Four colours are configured once for the competition and apply to all matches.
- The generator gives each active team the same number of appearances, spreads opponents and position assignments where feasible, supports multiple arenas, and does not schedule a team into concurrent matches.
- The generator reports the schedule seed and fairness measures.
- Operators can also create a match manually.
- Fewer than four assigned teams is permitted only with a recorded reason. Every schedule and arena view identifies an underfilled match and vacant position.
- A schedule uses explicit timestamps, arena names, match duration and effective start time. Competition-wide auto-run is the only automatic-start setting. Delays cascade in whole-minute increments. Custom events appear chronologically and block overlapping match times; adding or editing an event shifts conflicting future matches and later matches in affected arenas. Running matches and active countdowns cannot be silently moved.

### Live match operation and scoring

- Admins can manually start a match with a shared countdown, enable/disable competition-wide auto-run, add a reasoned delay, pause/resume the timer, and finish a match.
- Match clocks are authoritative on the server. Matches progress through scheduled, running, paused, awaiting-score and complete states.
- Scores are entered for every team in a completed match as points only. Any legacy structured result data is retained internally but is not required or shown during score entry.
- Corrections preserve the prior value, administrator, timestamp and correction reason.
- The league table adds each team's match points and lists rank, code, name, points and number of scored matches.

### Challenges

- Challenges belong to one competition instance and are not shared with another.
- Each challenge has a name, optional description and configured league-points award.
- An administrator records a team's successful completion. A given team can complete each challenge once; a database uniqueness constraint prevents duplicate awards.
- Challenge points are added to match points in the standings and frozen playoff seeds.

### Scheduled double-elimination playoffs

- Generate double-elimination playoffs for any selected field of 2 or more teams, up to all active teams, seeded from the current league table. Freeze this seed order at bracket creation.
- Playoffs are managed from Schedule, not a separate tab. Each heat is independently scheduled with dynamically resolved team positions, arena, start time, duration and ordinary event/match collision handling.
- Use four-team heats where possible and two- or three-team heats for remainders. In a two-team heat, the winner advances; in three- and four-team heats, the top two advance. The remaining participants take a loss and teams with two losses are eliminated.
- Set the first heat's scheduled start and spacing between heats. Schedule every planned heat in dependency order before its later teams are known; fill those positions from previous heat placements when scores are entered. Leave time between scheduled heats for score entry; late results do not automatically move later heat times.
- The final heat ranks the remaining four teams, or all remaining teams when the selected field has fewer than four, by points and frozen league seed tie-breaks. Playoff scores are separate from league scores and do not affect league points.
- Playoff points are kept separate from league match and challenge points. Corrections require a reason and are blocked once a dependent later heat has scores. Replacing a bracket archives its previous progression.
- Score corrections require a reason and are blocked after a later playoff match has been scored; replacing a bracket archives its prior progression.
- Upcoming, unscored playoff heats can be rescheduled individually or assigned to a different arena from the Schedule dashboard. Rescheduling shifts same-arena conflicts and respects custom event blocks; dependent heats must remain after their feeder heats.
- Multi-day schedules use timed events as break blocks. For example, schedule league matches from 11:00, add a 120-minute event at 13:30 and an 18-hour event at 17:00 to resume no earlier than 11:00 the next day. Add the second day's lunch event, then schedule playoff heats after lunch. A custom 20-minute event at the final's original start (or direct final-heat rescheduling) provides a buffer before the final.

### Public displays

- Administrators create a display by choosing one supported type, a title and a URL slug. The service does not execute administrator-supplied code or proxy arbitrary URLs.
- Each enabled display has a read-only JSON endpoint and a responsive HTML view suitable for a public page or iframe.
- Supported output types: league, schedule, match points history, arena, timer and corner. Match points history reports exact scores for completed league and playoff matches. Playoff heats are included in Schedule displays, and schedule displays can optionally expose a team filter, replace clock times with live relative time, or hide the arena column. Each display can independently use a dark theme.
- Administrators can clear all scheduled matches, playoff heats, match-score history and custom timed events for a competition. Require two explicit confirmations, reject the operation while matches are active or have a pending start countdown, and retain an audit record.
- Arena views show match number, team positions, competition-wide colours and vacancies; underfilled matches are clearly marked. Position numbers appear prominently in cell corners and the synchronized "starts in" countdown is explicit.
- Schedule position cells show only colour-coded team codes, with position numbers in the column headings. Schedule views list events chronologically with matches.
- Timer views poll current server state and render the remaining time, including paused time. Timer and Corner views take over the full screen for the synchronized 3-2-1-GO countdown.
- A Corner display selects one position (0–3) and shows only the assigned team name and shared match clock for a physical device beside that arena corner. Arena diagrams do not show separate clocks inside each square.
- Schedule displays can optionally hide events once their scheduled duration has elapsed.
- Public outputs are available only after competition publication. Administrators may disable or delete a display.

### Branding and operation

- Theme and logo settings are saved per competition and included in public display pages.
- Accept PNG, JPEG and WebP logos up to 1 MiB; validate file signature and type before saving.
- Every state-changing administrative action is recorded in the audit log.
- PostgreSQL is the durable source of truth. Backups and restore procedures must be tested before event use.
- The application listens on port 8080 on all container host interfaces. Use a TLS-terminating reverse proxy for public HTTPS and OIDC callback access.

## Architecture and integration

- TypeScript, Fastify and PostgreSQL, run with Docker Compose.
- Authentik OIDC Authorization Code flow with PKCE for administrator sign-in.
- Each successfully authenticated account from the configured identity provider currently has administrator access. Restrict account enrollment and provider access appropriately.
- Admin APIs require the application session cookie. Public display APIs are read-only.
- PostgreSQL transactions protect match control, scores, bracket advancement and audit writes.
- The schedule generator is deterministic when given its seed; generated output stores the chosen positions and times.

## Main endpoints

| Method and path | Purpose |
|---|---|
| `POST /api/admin/competitions` | Create a draft competition |
| `POST /api/admin/competitions/{slug}/publish` | Publish a competition |
| `POST /api/admin/competitions/{slug}/teams` | Add a team |
| `PATCH /api/admin/teams/{teamId}` | Update a team name or eligible active state |
| `DELETE /api/admin/teams/{teamId}` | Delete a team with no competition history |
| `DELETE /api/admin/competitions/{slug}` | Permanently delete an event after slug confirmation |
| `POST /api/admin/competitions/{slug}/challenges` | Create a competition-specific points challenge |
| `POST /api/admin/challenges/{challengeId}/completions` | Award the challenge once to an active team |
| `POST /api/admin/competitions/{slug}/generate-schedule` | Generate a balanced league schedule |
| `POST /api/admin/competitions/{slug}/clear-schedule` | Clear matches, playoff heats, score history and events after exact confirmation |
| `POST /api/admin/competitions/{slug}/events` | Add a timed schedule event and shift conflicting matches |
| `PATCH /api/admin/events/{eventId}` | Edit an event and shift conflicting matches |
| `POST /api/admin/competitions/{slug}/matches` | Create one manually configured match |
| `POST /api/admin/matches/{matchId}/{start,pause,resume,finish}` | Operate a match |
| `POST /api/admin/matches/{matchId}/delay` | Delay a match and following arena matches |
| `POST /api/admin/matches/{matchId}/scores` | Save or correct match scores |
| `POST /api/admin/competitions/{slug}/playoffs` | Generate a seeded bracket |
| `PATCH /api/admin/playoff-matches/{matchId}/schedule` | Reschedule an upcoming playoff heat or change its arena |
| `GET /api/admin/playoff-matches/{matchId}/scores` | Read current playoff scores |
| `POST /api/admin/playoff-matches/{matchId}/scores` | Save or correct scores and advance the bracket |
| `POST /api/admin/competitions/{slug}/displays` | Create a public display |
| `GET /api/public/display/{slug}` | Read a configured display as JSON |
| `GET /display/{slug}` | Read a configured display as HTML |
| `GET /public/v1/{slug}/league` | Read the public league table as JSON |
| `GET /embed/{slug}/league` | Embed the league table |

## Delivery and acceptance checks

1. Confirm sign-in, session expiry/logout, and administrator access through the configured OIDC provider.
2. Create a competition, add a roster, create a balanced schedule, and verify equal appearances, concurrency, opponent and corner metrics.
3. Create an underfilled manual match and verify its reason, warning and vacant arena positions are visible.
4. Operate manual and automatic matches, apply an arena delay, pause/resume clocks, finish, enter scores and correct a saved score.
5. Verify standings update after scores and score corrections.
6. Create separate challenges in two competitions; verify one-time completion and additive challenge standings/playoff seeds.
7. Verify a team with no history can be deleted and a team with records can only be deactivated.
8. Delete a competition after typed-slug confirmation and verify its data is removed while the deletion audit remains.
9. Generate and advance double-elimination playoff heats for every entrant count from 2 through the active roster, including 22. Verify 2/3/4-team heat advancement, second-loss elimination, final placement, league-seed tie breaks, score isolation, scheduled times, event collision handling and correction protection.
10. Shift event times through lunch and verify conflicting future matches and same-arena followers move, while active matches/countdowns are protected; confirm all schedule views stay chronological.
11. Create each public display type; verify independent dark themes, full-screen Timer/Corner countdowns, corner selection and schedule completed-event filtering, plus JSON, direct HTML and iframe output after publication.
12. Change theme/logo and verify persistence and public rendering. Reject unsupported, malformed and oversized logo files.
13. Verify automatic admin updates, unsaved-form preservation, service health, container restart, database persistence, backup and restore.
14. Run automated tests, type-check/build, dependency audit, authenticated API workflows and responsive browser checks.

## Current implementation and remaining release work

The TypeScript/Fastify service and PostgreSQL deployment already provide OIDC sessions, competition management, teams, balanced league scheduling, match control/delays, scores/corrections, challenge awards, additive standings, arena views, public JSON, displays, settings and bracket generation/advancement. The dashboard uses the navigation above and refreshes current data automatically.

Before event readiness, validate the new screens and workflows in a browser, run integration tests against a fresh database and an upgraded database, add durable versioned schema migrations, perform a production dependency audit, and rehearse PostgreSQL backup/restore. Confirm that the public DNS name and TLS reverse proxy forward the OIDC callback to the service. No credentials belong in this document.
