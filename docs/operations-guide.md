# Operations guide

How to run the event day with Competition Control: getting from the league to a
final, handling delays, and choosing public displays. Feature reference lives in
the [README](../README.md); repository and deployment notes are in
[REPOSITORY.md](REPOSITORY.md).

## Playoffs

Playoffs are generated from **Schedule → Schedule playoffs after the league**.
Entrants are the top *N* teams of the league table. Until the first playoff
countdown starts, seeds follow the live league table (new scores, corrections
and challenge awards all count); after that they are frozen. The
**Open standings sanity check** link shows the exact standings snapshot used.

### Choosing a route to the final

| Option | What it does |
|---|---|
| **Double elimination** | Finish below a heat's advancing places once and you drop to the lower bracket. A second loss eliminates you. The final takes the upper- and lower-bracket survivors (2 + 2 for a four-team final). |
| **Single elimination knockout** | Finish below the advancing places in any heat and you are out. Fewer heats, so it suits a tight timetable. |
| **Straight to the final** | No knockout rounds: the top 2–4 league teams play one final heat. Entrants must not exceed the final size. |
| **Teams in the final** | 4 (default), 3, or 2 for a head-to-head final. |
| **Top seeds straight to the final** | The league winner (or top 2 / top 3 seeds) skip the knockout rounds entirely and only play the final. The remaining final places are earned in the knockout. Rewards league performance. Double elimination needs at least two earned places, so with a four-team final you can seed at most two teams. |

The form previews the number of heats, how many stages they form, who
reaches the final, and a **bracket diagram** before anything is created. The
same diagram is shown on the Schedule page and the public Playoff bracket
display once the bracket exists: solid lines follow the winners' path, dashed
orange lines show drops to the lower bracket, and green lines lead into the
final. Invalid combinations are
explained in the preview and cannot be submitted.

### Heat sizes and seeding rules

- Every heat has two to four robots. A round of *n* teams uses heats of four
  where possible; a remainder of two or three becomes a smaller heat, and a
  remainder of one becomes a 3-team plus a 2-team heat, so **no one ever gets a
  single-team bye**.
- Top two progress from 3- and 4-team heats, the winner from a 2-team heat. When
  a side of the bracket must finish with an exact number of finalists, a heat
  may advance a different number; the heat card on the Schedule page says
  "Top N progress".
- First-round heats are filled in a serpentine by seed, so seeds 1 and 2 are
  never in the same opening heat. Later rounds avoid putting two teams from the
  same previous heat together wherever the heat sizes allow.
- **Ties within a heat are decided by the judge.** If tied teams' places lead
  to different outcomes (advance vs drop/out, or any final placing), the score
  dialog asks the judge to set the order and give a reason before it saves;
  replay the heat (Reset timer) or run a tie-break first if you want one.
  Ties that make no difference save normally. Playoff points never change
  league standings.
- **League ties** are separated by match points, then head-to-head points in
  league matches where the tied teams met, then best single match. Anything
  still level is flagged on the Schedule page before playoffs; decide it (for
  example with a tie-break run awarded as a challenge) before the first
  playoff countdown freezes the seeds.

### Size of each route

Heats / bracket stages (stages are columns of the bracket; with a single arena
the running time is roughly *heats × minutes between heats*):

| Route | 6 teams | 8 teams | 10 teams | 12 teams | 16 teams | 20 teams | 24 teams |
|---|---|---|---|---|---|---|---|
| Double elim, final of 4 | 6 / 4 | 6 / 4 | 12 / 6 | 14 / 7 | 15 / 7 | 23 / 9 | 26 / 10 |
| Double elim, final of 4, top 2 seeded | 4 / 4 | 7 / 5 | 9 / 6 | 13 / 7 | 18 / 9 | 24 / 10 | 27 / 11 |
| Single elim, final of 4 | 3 / 2 | 3 / 2 | 5 / 3 | 6 / 3 | 7 / 3 | 10 / 4 | 12 / 4 |
| Single elim, final of 4, winner seeded | 3 / 2 | 4 / 3 | 6 / 3 | 6 / 3 | 8 / 4 | 11 / 4 | 12 / 4 |
| Single elim, head-to-head final | 4 / 3 | 4 / 3 | 7 / 4 | 7 / 4 | 8 / 4 | 12 / 5 | 13 / 5 |

### Worked example: eight teams, double elimination

| Heat | Bracket | Entrants |
|---|---|---|
| 1 | Upper R1 | Seeds 1, 4, 5, 8 |
| 2 | Upper R1 | Seeds 2, 3, 6, 7 |
| 3 | Lower R1 | 3rd and 4th of heats 1 and 2 |
| 4 | Upper R2 | 1st and 2nd of heats 1 and 2 |
| 5 | Lower R2 | 1st and 2nd of heat 3, 3rd and 4th of heat 4 |
| Final | Final | 1st and 2nd of heat 4 (unbeaten), 1st and 2nd of heat 5 |

The same eight teams in a single-elimination knockout need only three heats:
the two opening heats, then a final of their top two.

### Worked example: ten teams, double elimination, top two seeded

Seeds 1 and 2 go straight to the final. Seeds 3–10 play a double-elimination
bracket that produces one unbeaten finalist (upper bracket) and one
lower-bracket finalist, giving a four-team final of seed 1, seed 2, the upper
winner and the lower winner.

### Scheduling the heats

- **First playoff heat** defaults to just after the current schedule ends.
  Add a lunch or break event first if there should be one between the league
  and the playoffs; heats are moved around timed events automatically.
- **Arenas** takes a comma-separated list. With more than one arena, heats that
  don't depend on each other run side by side; each heat is placed in the arena
  that lets it start soonest. The final always waits for every other heat.
- **Minutes between heats** is the slot length (must be at least the match
  duration); the planned gap after each heat is that minus the match duration.
- **Extra delay before final** adds a buffer, e.g. for presentations.
- Individual heats can be moved to another time or arena from the Schedule
  table (**Edit schedule**). A heat is never placed before the heats that feed
  it have finished, plus its gap; if you ask for an earlier time it is moved to
  the earliest valid time.

Replacing a bracket archives the old one (its heats and playoff scores are kept
for the audit trail but no longer shown).

## Handling delays

Everything that changes the timetable — a late or early start, an explicit
delay, resuming a paused match, resetting a timer, editing a match or heat,
adding or moving an event, entering a playoff result — runs the same
**re-flow**:

1. Later league matches **and playoff heats in the same arena** keep their
   place in the queue and their planned spacing behind the match that moved.
2. Playoff heats are kept behind the heats that feed them, including waiting
   for a result to be entered.
3. Everything that has not started moves past timed events (lunch, talks,
   overnight breaks). Running and paused matches hold their arena until their
   projected end.

Matches and heats are never pulled earlier automatically. Use **Reduce delay**
(per match or heat) or **Undelay all future matches** for that; both refuse to
create overlaps.

### Tools in Live control

| Situation | Use |
|---|---|
| One match will start late (robot repair, missing team) | **Add delay** on that match or heat. Later items in the arena follow. |
| The whole event is behind (field fault, long ceremony) | **Delay all upcoming…** with the number of minutes, a reason and optionally one arena. |
| A delay was too generous | **Reduce delay** on the match/heat, or **Restore original scheduled time**. |
| Recovered time and want to return to the plan | **Undelay all future matches** restores everything whose original start is still in the future and would not conflict. |
| A start went wrong | **Reset timer** (before scores are entered) re-schedules the match for the next full minute and re-flows. |

The **Schedule status** strip at the top of Live control shows, per arena,
whether the next match is on time, how far behind it is, or whether it is
overdue to start. Public schedule displays show the same information to
competitors: the original time is struck through, the status reads
"Delayed N min", and a banner says how far behind the event is running.

With auto-run **off**, a match whose time arrives moves to the top of Live
control's Active list with a "Due now · press Start" badge, and timer and SR
screens show "Waiting to start". The clock only runs once someone presses
Start. With **competition auto-run** on, league matches and ready playoff heats start
on their own at their effective time. A heat whose teams or arena are still in
another match waits until they are free and then gets a fresh countdown.

Playoff heats in an arena always run in schedule order. If the next heat is
still waiting for results from another heat, Live control shows it as next
("waiting for earlier results") and nothing after it can start — auto-run
waits, and pressing Start on a later heat explains which heat comes first. To
run a later heat first on purpose, delay the earlier heat past it.

Countdowns start on a whole server second, at least one second after Start is
pressed, so every screen (non-SR and SR) shows GET READY, 3, 2, 1 and GO at the
same moment. Keep the server's clock on NTP; screens synchronize to the server.

## Staging and shepherding

Set the staging rules on the **Arena** page: staging for a match opens when the
previous match in its arena starts, and closes a number of minutes later
(default five, never after the match itself starts). The first match opens a
set lead before its start (default ten minutes). The SR Shepherding and Staging
screens use these server-calculated times, including for playoff heats.

## Running matches and scores

Live control shows one console per arena. The big panel is always the match that needs you:
a countdown, the running or paused match (with Pause, Finish now and Reset timer), or the next
match with a large **Start** button and **Delay**. Its queue is listed underneath.

When a match's timer ends, every screen shows END and then moves on to the next match, whether
or not anyone has entered scores. The finished match appears as a slim strip at the top of its
arena and on the **Scores** page, where scores are typed straight into a card. Use **No score**
for practice runs or void matches; scores can still be added later from Recent results. The
sidebar counts matches that are due to start and matches waiting for scores.

Everything updates live on every open dashboard and display, so several people can run arenas
and enter scores at the same time.

## Signing in during an outage

If the organisation sign-in (identity provider) is down, use **Sign in with a passkey** on the
sign-in page. Add a passkey before the event under **Admin → Access & passkeys** on each device
you will use (phones and laptops both work). If someone has no passkey and the provider is down,
run on the server:

```sh
docker compose exec app node dist/cli.js invite person@example.com
```

and send them the printed link; it works once, for 30 minutes.

## Choosing displays

| Screen | Display type | Notes |
|---|---|---|
| Arena timer / stream overlay | Match timer | Full-screen synchronized clock, arena layout, optional previous result. |
| Next to the arena | Arena diagram | Which team is in which corner, with the clock; fits the screen. Set **Arena** in a multi-arena event. |
| At each corner | Corner display | One per corner; large team code in the corner colour. Set **Arena** in a multi-arena event. |
| Pit / queueing area | Schedule | Enable the team filter so teams can find their next match. Delays are shown live. |
| Main hall during playoffs | Playoff bracket | Heats by stage with results; eliminated teams are struck through. |
| Website or results screen | League table, Match points history | Embed with **Copy embed**. |
| Main hall / foyer | Custom screen | Mix the schedule, league, knockout, live timer, announcements and sponsor images; split or rotating. |
| Playoff hall | Knockout diagram | Just the bracket, filling the screen. |
| SR-style venue screens | SR — Arena / Outside / Producer / Shepherding / Staging | Original SRComp pages backed by this system. |

### Music, live sound and beeps

1. On **Audio & media**, upload music (only tracks you have the rights to play). New tracks join the
   playlist; reorder or remove them there.
2. In **Displays → Configure**, tick **Play the competition audio** on each screen connected to a
   speaker (and set that screen's volume). Click each screen once so the browser allows sound, or
   start kiosk browsers with `--autoplay-policy=no-user-gesture-required`.
3. Press **Play**. Every audio screen plays the same moment of the track. Volume, pause, skip and
   repeat apply to all of them at once.
4. For live sound (a DJ, a microphone, or music from a streaming service), choose the source under
   **Live audio** and press **Start live audio**. To share a browser tab, pick the tab and tick
   **Share tab audio**. Keep that admin page open; the playlist pauses while live audio is on.

Race beeps are a separate option on Timer, Arena, Corner and custom screens.

Switch competitions from the card at the top of the sidebar (it shows each
competition's status; **Manage competitions…** opens the full list).

Displays only work once the competition is **published**. Each display type
only shows the options it uses. Board displays (league, schedule, results,
playoff bracket) refresh in place every five seconds without reloading the
page; live displays (timer, arena, corner) synchronize to the server clock
every second.
