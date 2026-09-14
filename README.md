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

## Reminder settings and time zones: app and API work still needed

The database is ready, but the app doesn't write these values yet:
- **`users.timezone`:** the app should send `Intl.DateTimeFormat().resolvedOptions().timeZone` after sign-in, for example as part of the profile update.
- **`reminderSettings`:** a Settings screen with switches for each reminder type and quiet hours (`HH:mm`), plus an API endpoint to read and update the row. A missing row means everything is on.

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
