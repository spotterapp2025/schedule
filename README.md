# Spotter schedule worker

Background worker that sends Spotter's push reminders. Reminders help people keep to their workout plan, hit their step goal, track calories, and reply to workout partners.

It has no UI and no HTTP API, apart from an optional health check. It reads the API's MySQL database and sends pushes through Expo.

## Reminders

Times are the **user's local time**.

| Reminder | When | Who gets it | Opens |
| --- | --- | --- | --- |
| Breakfast / lunch / dinner check-in | 07:00 / 11:50 / 18:15 | Users who haven't logged that meal today | Daily tracker |
| Step progress | 10:30, 14:30, 19:30 | Users with a step goal who haven't reached it yet (including 0 steps); users without a goal get one prompt at 10:30; reaching the goal triggers one congratulations | Step progress |
| Workout day | 06:45 / 11:30 / 17:30 for a morning / afternoon / evening plan (08:00 if no preferred time) | Users whose workout plan includes today | Discover (find a partner) |
| Calorie summary | 20:30 | Everyone: food eaten vs goal and calories burned, or a nudge if nothing was logged | Daily tracker |
| Workout partners digest | Sundays 18:00 | Users with pending connection requests or new likes from the last 7 days (blocked users excluded) | Notifications |
| "Did you work out today?" | The user's check-in time (default 20:00, 06:00–22:30; Profile or Workout calendar) | Users whose plan includes today, with the reminder on and today not yet marked as completed. Waits 20 min after any other push | Workout calendar |
| Streak reminder | The user's reminder time (default 19:00, 06:00–22:00) | Users with an active streak (last completed day = yesterday) whose day isn't done yet. One message covers both streaks | Streaks screen |
| Streak at risk | 21:30 | Streaks of 3+ days still not done today | Streaks screen |
| Streak celebration / milestone | 30+ minutes after the day is completed (07:00–23:00) | Streaks of 2+ days that grew today; milestone copy at 3, 7, 14, 30, 50 and 100 days | Streaks screen |
| Challenge started | Once, when a challenge begins (08:00–21:00 in the challenge's time zone) | Everyone who joined | The challenge |
| Challenge milestone | When a participant's progress reaches 50% and 100% of the target (08:00–21:00) — each at most once per challenge | That participant only | The challenge |
| Challenge finished | After the last day (08:00–21:00): results are frozen (rank, winner, progress) once | Everyone who joined: won / shared first place / finished #N with the winner | The challenge |
| Meal plan QR code expired / limit reached | Within 5 minutes of it happening (any time) | The owner of a meal plan that is still shared, once per QR code; also saved on the Notifications screen. The API already refuses the code the moment it expires | Shared meal plans |

Nutrition challenge progress counts calories imported from Apple Health / Health Connect (the `healthDays` table from api migration 0017) as well as logged meals — the higher of the two per day. Before that migration runs, only meals count.

Streaks are calculated by the API (`api/streaks`) from step and meal logs and cached in `streakState`; the worker reads that cache plus today's live steps/meals, so a day completed after the cache was written still cancels its reminder. A step day counts at the step goal, a nutrition day at 80% of the calorie target. Streak notifications have their own switches (step / nutrition streak, reminders, warnings, celebrations, milestones) and start once api migration `0008_streaks` is applied.

### Streak notification limits

Streak pushes must help, not nag. `src/reminders/limits.js` checks each user's recent notifications (`reminderLog`) before anything is claimed; the numbers live in `STREAK_LIMITS` (`definitions.js`):

| Rule | Why |
| --- | --- |
| One reminder, one warning and one celebration or milestone per day, each covering both streaks | Never a separate push per streak |
| At most 2 streak pushes a day (milestones don't count) | A reminder and a warning is plenty; a late celebration waits for another day |
| No streak reminder or warning within 90 min of any other push | Doesn't pile onto the dinner, workout or calorie reminders |
| The warning needs a 3+ day streak and comes 2 h+ after the reminder | Short streaks and back-to-back nudges aren't worth a second push |
| Ordinary celebrations at most every 3 days (milestones always, and they reset the clock) | Celebrating every single day stops meaning anything |
| Celebrations wait 30 min after the day was completed | The app already celebrates in place while it's open |
| The regular step check-in is skipped within 90 min after a streak reminder, and "Step goal reached" and a step streak celebration never both go out | No two step pushes about the same thing |

Held-back notifications are counted per reason in the tick summary (`limited`).

Every reminder:
- **Is sent at most once per user per local day.** The weekly digest is once per week. This holds across restarts and multiple worker instances.
- **Only goes to users who finished onboarding and have a push token.**
- **Respects the user's reminder switches and quiet hours** (`reminderSettings`).

Copy lives in `src/reminders/messages.js` and times in `src/reminders/definitions.js`.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in the database settings.
3. Apply the API migrations, which add `users.timezone`, `reminderSettings` and `reminderLog`:
   ```bash
   cd ../api && npm run migrate
   ```
   The worker also runs **before** the migration. Until then everyone uses `REMINDER_DEFAULT_TIMEZONE`, all reminders are on, and duplicate protection is kept in memory. It checks again every hour, so no restart is needed after migrating.

## Running

```bash
npm start           # run on schedule (checks every 5 minutes)
npm run once        # run one check now and exit
npm run dry-run     # one check; logs what would be sent; sends and records nothing
node server.js --once --dry-run --at=2026-09-14T07:05:00+02:00   # simulate a moment in time
```

Production: run `node server.js` under a process manager (systemd, pm2, Docker, Kubernetes). It stops cleanly on `SIGTERM`/`SIGINT` and finishes the current batch first. Set `HEALTH_PORT` to expose `GET /health`, which returns 200 while checks are succeeding and 503 when they have stopped or are failing.

## How it works

```
cron tick (every 5 min, never overlapping)
  └─ for each time zone that has a reminder due now (within REMINDER_GRACE_MINUTES)
       └─ query the audience in pages of 1,000 users  (src/reminders/audience.js)
            └─ build messages → claim in reminderLog → send to Expo in batches of 100
maintenance (every 15 min)
  └─ fetch Expo receipts → mark delivered/failed → remove tokens of uninstalled apps → prune old log rows
```

- **Time zones.** `users.timezone` holds an IANA name such as `Europe/Oslo`. Missing or invalid values use `REMINDER_DEFAULT_TIMEZONE`. "Today" for meals and calories is the user's local day. Step days use the local date the app syncs.
- **Failures.** If Expo is unreachable, claims are released and the next tick retries within the grace period. A failing reminder type doesn't stop the others. Invalid or unregistered tokens are removed from `socketio`.
- **Privacy.** Queries select only the columns needed; they never select `users.*` or passwords. Push tokens aren't written to logs.

## Reminder settings and time zones

- **`users.timezone`:** the app sends the device time zone (`PUT /v1/user/:userID/timezone`) when Home or the Daily Tracker opens.
- **`reminderSettings`:** Settings → Streak notifications edits the streak switches, the reminder time and quiet hours (`GET/PUT /v1/streaks/user/:userID/preferences`). Quiet hours apply to every reminder. The meal, step, workout, calorie and partner switches have no screen yet; a missing row means everything is on.

## Development

```bash
npm run check       # lint + type-check + tests
npm test            # unit tests: no database, network or real pushes
```

The tests cover:
- time-zone and DST handling, and quiet hours
- which reminders are due and their copy
- SQL parameter binding for every query and database capability combination
- send-once claims, batching and retries
- receipts and token cleanup
- the full tick
