// Streak notifications: which checks are due, the audience SQL, the copy, and a simulated day through the runner.
// No database or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DateTime } from "luxon";
import { MACRO_COMPLETION_RATIO, STREAK_MILESTONES, STREAK_TYPES, dueStreakChecks } from "../src/reminders/definitions.js";
import { streakAudienceQueries } from "../src/reminders/audience.js";
import { streakCelebration, streakReminder, streakWarning } from "../src/reminders/messages.js";
import { createReminderRunner } from "../src/reminders/runner.js";
import { createMemoryClaimStore } from "../src/reminders/claims.js";
import { createFakeDb, placeholderCount, silentLogger, staticCapabilities, token } from "./helpers.js";

const at = (iso) => DateTime.fromISO(iso, { zone: "Europe/Oslo" });
const types = (due) => due.map((d) => d.type);
const DATES = { today: "2026-09-14", yesterday: "2026-09-13" };

test("streak constants match the API's streak rules", async (t) => {
  const apiRules = new URL("../../api/streaks/streakRules.js", import.meta.url);
  if (!existsSync(apiRules)) return t.skip("api folder not deployed next to the worker");
  const api = await import(apiRules.href);
  assert.deepEqual(STREAK_MILESTONES, api.STREAK_MILESTONES);
  assert.deepEqual(STREAK_TYPES, api.STREAK_TYPES);
  assert.equal(MACRO_COMPLETION_RATIO, api.MACRO_COMPLETION_RATIO);
  assert.equal(api.DEFAULT_STREAK_PREFERENCES.reminderTime, "19:00");
});

test("the reminder window covers the last grace minutes, within 06:00–22:00", () => {
  const due = dueStreakChecks(at("2026-09-14T19:10"), 30);
  assert.deepEqual(types(due), ["streakReminder", "streakCelebrate"]);
  assert.deepEqual(due[0].window, { from: 18 * 60 + 41, to: 19 * 60 + 10 });
  assert.deepEqual(dueStreakChecks(at("2026-09-14T22:20"), 30)[0].window, { from: 22 * 60 - 9, to: 22 * 60 });
  assert.equal(types(dueStreakChecks(at("2026-09-14T22:31"), 30)).includes("streakReminder"), false);
});

test("the warning is due once in the evening, and nothing is due at night", () => {
  assert.equal(types(dueStreakChecks(at("2026-09-14T21:35"), 30)).includes("streakWarning"), true);
  assert.equal(types(dueStreakChecks(at("2026-09-14T22:05"), 30)).includes("streakWarning"), false);
  assert.deepEqual(dueStreakChecks(at("2026-09-14T23:30"), 30), []);
  assert.deepEqual(dueStreakChecks(at("2026-09-14T03:00"), 30), []);
});

const ARGS = { localDate: "2026-09-14", yesterday: "2026-09-13", start: "2026-09-13 22:00:00", end: "2026-09-14 22:00:00", window: { from: 1110, to: 1140 } };
const ctx = (userTimezone) => ({ caps: { userTimezone, settings: true, log: true, blocks: true, streaks: true }, zoneValues: ["Europe/Oslo"], defaultTimeZone: "Europe/Oslo" });

test("one audience query per stage covers both streaks and binds one value per placeholder", () => {
  for (const [type, build] of Object.entries(streakAudienceQueries)) {
    for (const userTimezone of [true, false]) {
      const { sql, params } = build(ctx(userTimezone), ARGS, 0, 1000);
      assert.equal(placeholderCount(sql), params.length, `${type}/${userTimezone}`);
      assert.match(sql, new RegExp(`/\\* audience:${type} \\*/`));
      assert.match(sql, /streakType = 'steps'[\s\S]*streakType = 'macro'/);
      assert.match(sql, /COALESCE\(rs\.stepStreak, 1\) = 1[\s\S]*COALESCE\(rs\.macroStreak, 1\) = 1/);
      assert.match(sql, /ORDER BY u\.userID LIMIT \?$/);
    }
  }
  const reminder = streakAudienceQueries.streakReminder(ctx(true), ARGS, 5, 100);
  assert.deepEqual(reminder.params, [ARGS.start, ARGS.end, ARGS.localDate, "Europe/Oslo", ["Europe/Oslo"], "19:00", 1110, 1140, ARGS.yesterday, ARGS.yesterday, 5, 100]);
  const warning = streakAudienceQueries.streakWarning(ctx(false), ARGS, 0, 100);
  assert.deepEqual(warning.params, [ARGS.start, ARGS.end, ARGS.localDate, 3, ARGS.yesterday, 3, ARGS.yesterday, 0, 100]);
});

/** An audience row: a 3-day step streak through yesterday, no nutrition streak. */
const row = (overrides = {}) => ({
  userID: 1,
  token: token(1),
  quietStart: null,
  quietEnd: null,
  stepStreakOn: 1,
  macroStreakOn: 1,
  celebrations: 1,
  milestones: 1,
  stepGoal: "10000",
  steps: 4000,
  kcalTarget: 2500,
  eaten: 0,
  stepsStreak: 3,
  stepsLastCompleted: "2026-09-13",
  stepsStateAge: 600,
  macroStreak: 0,
  macroLastCompleted: null,
  macroStateAge: null,
  ...overrides,
});

test("reminders: one message for whichever streaks need today, none once done", () => {
  assert.deepEqual(streakReminder(row(), DATES), {
    kind: "streak:reminder",
    title: "👟 Keep your step streak going",
    body: "You're on a 3-day step streak. 6,000 steps to go today.",
    data: { type: "streak", streak: "steps" },
    limit: { topics: ["steps"] },
  });
  const both = streakReminder(row({ macroStreak: 5, macroLastCompleted: "2026-09-13", eaten: 300 }), DATES);
  assert.equal(both.title, "🔥 Keep your streaks going");
  assert.equal(both.body, "Your 3-day step streak and 5-day nutrition streak are waiting: 6,000 steps to go and today's meals to log.");
  assert.deepEqual(both.data, { type: "streak", streak: "all" });
  assert.equal(streakReminder(row({ steps: 10000 }), DATES), null, "completed today");
  assert.equal(streakReminder(row({ stepStreakOn: 0 }), DATES), null, "streak switched off");
  assert.equal(streakReminder(row({ stepsLastCompleted: "2026-09-11" }), DATES), null, "no active streak");
  assert.equal(streakReminder(row({ stepsStreak: 0, macroStreak: 4, macroLastCompleted: "2026-09-13", eaten: 2000 }), DATES), null, "80% of the calorie target completes the day");
});

test("warnings: only for streaks of 3+ days", () => {
  assert.equal(streakWarning(row({ steps: 8800 }), DATES).body, "You're close—1,200 steps left to keep your 3-day streak.");
  assert.equal(streakWarning(row({ steps: 0 }), DATES).body, "There's still time for a walk today to keep your 3-day step streak.");
  assert.equal(streakWarning(row({ stepsStreak: 2 }), DATES), null);
  assert.equal(streakWarning(row({ stepsStreak: 1, macroStreak: 6, macroLastCompleted: "2026-09-13" }), DATES).body, "Complete today's meal log to protect your 6-day streak.");
});

test("celebrations: wait until the day has settled, milestones first, one message for both", () => {
  assert.equal(streakCelebration(row({ steps: 10000, stepsStreak: 4, stepsLastCompleted: "2026-09-14", stepsStateAge: 10 }), DATES), null, "just completed: wait");
  const grew = streakCelebration(row({ steps: 10000, stepsStreak: 4, stepsLastCompleted: "2026-09-14", stepsStateAge: 45 }), DATES);
  assert.deepEqual([grew.kind, grew.title], ["streak:celebrate", "🔥 4 days in a row"]);

  // State from yesterday (6 days) + today complete = 7, a milestone.
  const milestone = streakCelebration(row({ steps: 10200, stepsStreak: 6 }), DATES);
  assert.deepEqual([milestone.kind, milestone.title, milestone.body], ["streak:milestone", "🏅 7-day milestone", "Your 7-day step streak is complete!"]);
  assert.equal(streakCelebration(row({ steps: 10200, stepsStreak: 6, milestones: 0 }), DATES).kind, "streak:celebrate");
  assert.equal(streakCelebration(row({ steps: 10200, stepsStreak: 4, celebrations: 0 }), DATES), null);

  const both = streakCelebration(row({ steps: 10000, macroStreak: 1, macroLastCompleted: "2026-09-13", eaten: 2100 }), DATES);
  assert.deepEqual([both.title, both.body], ["🔥 Both streaks grew today", "4 days of step goals and 2 days of logged meals. Nice work!"]);
  assert.equal(streakCelebration(row({ steps: 10000, stepsStreak: 0, stepsLastCompleted: null }), DATES), null, "day one isn't celebrated");
});

test("a simulated day stays within the limits and waits for migration 0008", async () => {
  let now = new Date("2026-09-14T17:05:00Z"); // 19:05 in Oslo
  let user = row();
  const firstPage = (rows) => (params) => (params.at(-2) === 0 ? rows() : []);
  const sent = [];
  const make = (streaks) =>
    createReminderRunner({
      db: createFakeDb({
        zones: () => [{ zone: "Europe/Oslo" }],
        clock: () => [{ offsetMinutes: 120 }],
        "audience:streakReminder": firstPage(() => [user]),
        "audience:streakWarning": firstPage(() => [user]),
        "audience:streakCelebrate": firstPage(() => [user]),
        "audience:steps": firstPage(() => [{ userID: 1, token: token(1), quietStart: null, quietEnd: null, stepGoal: user.stepGoal, steps: user.steps }]),
      }),
      store: createMemoryClaimStore({ now: () => now.getTime() }),
      sender: {
        async send(items) {
          sent.push(...items);
          return items.map((item) => ({ item, outcome: "sent", ticketID: "t" }));
        },
        async clearTokens() {},
      },
      logger: silentLogger,
      capabilities: staticCapabilities({ userTimezone: true, settings: true, log: false, blocks: true, streaks }),
      config: { defaultTimeZone: "Europe/Oslo", graceMinutes: 30, dryRun: false },
      now: () => now,
    });
  const kinds = () => sent.map((item) => item.kind);

  await make(false).tick();
  assert.deepEqual(kinds(), [], "no streak pushes before the migration");

  const runner = make(true);
  await runner.tick();
  assert.deepEqual(kinds(), ["streak:reminder"]);

  now = new Date("2026-09-14T17:35:00Z"); // 19:35: the regular step check-in pauses after the streak reminder
  const checkIn = await runner.tick();
  assert.deepEqual(kinds(), ["streak:reminder"]);
  assert.equal(checkIn.limited["streak-reminder-recent"], 1);

  now = new Date("2026-09-14T19:35:00Z"); // 21:35: the warning, 2.5 h after the reminder
  user = row({ steps: 7000 });
  await runner.tick();
  assert.deepEqual(kinds(), ["streak:reminder", "streak:warning"]);

  now = new Date("2026-09-14T20:10:00Z"); // 22:10: goal reached, but two streak pushes today is enough
  user = row({ steps: 10400 });
  const capped = await runner.tick();
  assert.deepEqual(kinds(), ["streak:reminder", "streak:warning"]);
  assert.equal(capped.limited["daily-cap"], 1);

  now = new Date("2026-09-15T09:40:00Z"); // next day 11:40: the 7-day milestone, once the day has settled
  const next = { today: "2026-09-15", yesterday: "2026-09-14" };
  user = row({ steps: 10000, stepsStreak: 7, stepsLastCompleted: next.today, stepsStateAge: 10 });
  await runner.tick();
  assert.equal(sent.length, 2, "completed 10 minutes ago: not yet");
  user = { ...user, stepsStateAge: 45 };
  now = new Date("2026-09-15T10:15:00Z");
  await runner.tick();
  await runner.tick();
  assert.deepEqual(kinds(), ["streak:reminder", "streak:warning", "streak:milestone"]);
  assert.equal(sent[2].message.body, "Your 7-day step streak is complete!");
});
