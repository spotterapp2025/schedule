// "Did you work out today?" reminders: when they're due, who gets them, the copy, limits and a runner tick.
// No database or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { dueWorkoutCheckIns } from "../src/reminders/definitions.js";
import { workoutAudienceQueries } from "../src/reminders/audience.js";
import { workoutCheckIn } from "../src/reminders/messages.js";
import { isLimited, limitReason } from "../src/reminders/limits.js";
import { createReminderRunner } from "../src/reminders/runner.js";
import { createMemoryClaimStore } from "../src/reminders/claims.js";
import { createFakeDb, placeholderCount, silentLogger, staticCapabilities, token } from "./helpers.js";

const at = (iso) => DateTime.fromISO(iso, { zone: "Europe/Oslo" });

test("the check-in window covers the last grace minutes on the user's local clock, 06:00–22:30", () => {
  assert.deepEqual(dueWorkoutCheckIns(at("2026-09-14T20:10"), 30), [{ type: "workoutCheckIn", weekday: "MON", window: { from: 19 * 60 + 41, to: 20 * 60 + 10 } }]);
  assert.deepEqual(dueWorkoutCheckIns(at("2026-09-14T22:45"), 30)[0].window, { from: 22 * 60 + 16, to: 22 * 60 + 30 });
  assert.deepEqual(dueWorkoutCheckIns(at("2026-09-14T23:05"), 30), []);
  assert.deepEqual(dueWorkoutCheckIns(at("2026-09-14T05:30"), 30), []);
  assert.equal(dueWorkoutCheckIns(at("2026-09-19T20:00"), 30)[0].weekday, "SAT");
});

const ARGS = { weekday: "MON", localDate: "2026-09-14", weekStart: "2026-09-14", window: { from: 1181, to: 1210 } };
const ctx = (userTimezone) => ({ caps: { userTimezone, settings: true, log: true, blocks: true, workoutCheckIn: true }, zoneValues: ["Europe/Oslo"], defaultTimeZone: "Europe/Oslo" });

test("only planned workout days, reminder on, time in the window, and today not marked", () => {
  for (const userTimezone of [true, false]) {
    const { sql, params } = workoutAudienceQueries.workoutCheckIn(ctx(userTimezone), ARGS, 0, 1000);
    assert.equal(placeholderCount(sql), params.length);
    assert.match(sql, /\/\* audience:workoutCheckIn \*\//);
    assert.match(sql, /COALESCE\(rs\.workoutCheckIn, 1\) = 1/);
    assert.match(sql, /JSON_CONTAINS\(wp\.workoutDays/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM workoutCompletions done WHERE done\.userID = u\.userID AND done\.workoutDate = \?\)/);
    assert.match(sql, /ORDER BY u\.userID LIMIT \?$/);
  }
  const { params } = workoutAudienceQueries.workoutCheckIn(ctx(true), ARGS, 7, 100);
  assert.deepEqual(params, ["2026-09-14", "2026-09-14", "Europe/Oslo", ["Europe/Oslo"], "20:00", 1181, 1210, "MON", "Mon", "2026-09-14", 7, 100]);
});

test("the message asks the question and shows this week's progress when there's a goal", () => {
  assert.deepEqual(workoutCheckIn({ goal: 5, completedThisWeek: 2 }), {
    kind: "workout:check-in",
    title: "💪 Did you work out today?",
    body: "Tap to mark today's workout as completed. You've logged 2 of 5 workouts this week.",
    data: { type: "workout-check-in" },
  });
  assert.equal(workoutCheckIn({ goal: null, completedThisWeek: 0 }).body, "Tap to mark today's workout as completed.");
});

test("the check-in waits 20 minutes after any other push", () => {
  const candidate = { userID: 1, kind: "workout:check-in", localDate: "2026-09-14" };
  assert.equal(isLimited("workout:check-in"), true);
  assert.equal(limitReason(candidate, [{ kind: "meal:dinner", localDate: "2026-09-14", ageMinutes: 10 }]), "recent-push");
  assert.equal(limitReason(candidate, [{ kind: "meal:dinner", localDate: "2026-09-14", ageMinutes: 25 }]), null);
});

test("a tick sends it once a day, holds it after another push, and waits for the migrations", async () => {
  let now = new Date("2026-09-14T18:05:00Z"); // 20:05 on a Monday in Oslo
  const sent = [];
  const store = createMemoryClaimStore({ now: () => now.getTime() });
  const rows = [
    { userID: 1, token: token(1), quietStart: null, quietEnd: null, goal: 5, completedThisWeek: 1 },
    { userID: 2, token: token(2), quietStart: "20:00", quietEnd: "07:00", goal: 3, completedThisWeek: 0 },
  ];
  const make = (workoutCheckInCap) =>
    createReminderRunner({
      db: createFakeDb({
        zones: () => [{ zone: "Europe/Oslo" }],
        clock: () => [{ offsetMinutes: 120 }],
        "audience:workoutCheckIn": (params) => (params.at(-2) === 0 ? rows : []),
      }),
      store,
      sender: {
        async send(items) {
          sent.push(...items);
          return items.map((item) => ({ item, outcome: "sent", ticketID: "t" }));
        },
        async clearTokens() {},
      },
      logger: silentLogger,
      capabilities: staticCapabilities({ userTimezone: true, settings: true, log: false, blocks: true, streaks: false, workoutCheckIn: workoutCheckInCap }),
      config: { defaultTimeZone: "Europe/Oslo", graceMinutes: 30, dryRun: false },
      now: () => now,
    });

  await make(false).tick();
  assert.equal(sent.length, 0, "nothing before api migrations 0009/0010");

  // User 1 got another push 5 minutes ago: hold the check-in.
  const [meal] = await store.claimMany([{ userID: 1, token: token(1), kind: "meal:dinner", localDate: "2026-09-14" }]);
  await store.complete([{ claim: meal, status: "sent" }]);
  now = new Date("2026-09-14T18:10:00Z");
  const runner = make(true);
  const held = await runner.tick();
  assert.equal(sent.length, 0);
  assert.equal(held.limited["recent-push"], 1);
  assert.equal(held.skippedQuiet, 1, "quiet hours are respected");

  now = new Date("2026-09-14T18:30:00Z"); // 20:30: the gap has passed, still inside the window
  await runner.tick();
  assert.deepEqual(sent.map((item) => [item.userID, item.kind, item.message.data.type]), [[1, "workout:check-in", "workout-check-in"]]);
  now = new Date("2026-09-14T18:35:00Z");
  await runner.tick();
  assert.equal(sent.length, 1, "once per day");
});
