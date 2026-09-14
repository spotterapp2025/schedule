import { test } from "node:test";
import assert from "node:assert/strict";
import { audienceQueries, zoneQuery } from "../src/reminders/audience.js";
import { placeholderCount } from "./helpers.js";

const ARGS = {
  meal: { meal: "Lunch", since: "2026-09-14 00:00:00" },
  steps: { localDate: "2026-09-14" },
  workout: { weekday: "MON", preferredTimes: ["morning"] },
  calories: { start: "2026-09-14 00:00:00", end: "2026-09-15 00:00:00" },
  partners: {},
};

const allCapabilities = [];
for (const userTimezone of [true, false]) {
  for (const settings of [true, false]) {
    for (const blocks of [true, false]) allCapabilities.push({ userTimezone, settings, blocks, log: false });
  }
}

const build = (type, caps) => audienceQueries[type]({ caps, zoneValues: ["Europe/Oslo", "Bad/Zone"], defaultTimeZone: "Europe/Oslo" }, ARGS[type], 0, 1000);

test("every audience query binds exactly one value per placeholder", () => {
  for (const caps of allCapabilities) {
    for (const type of Object.keys(audienceQueries)) {
      const { sql, params } = build(type, caps);
      assert.equal(placeholderCount(sql), params.length, `${type} with ${JSON.stringify(caps)}`);
      assert.match(sql, new RegExp(`/\\* audience:${type} \\*/`));
      assert.match(sql, /u\.isComplete = 1/);
      assert.match(sql, /ORDER BY u\.userID LIMIT \?$/);
    }
  }
});

test("optional tables are only referenced when they exist", () => {
  const withAll = { userTimezone: true, settings: true, blocks: true, log: true };
  const without = { userTimezone: false, settings: false, blocks: false, log: false };

  assert.match(build("meal", withAll).sql, /COALESCE\(rs\.mealReminders, 1\) = 1/);
  assert.match(build("partners", withAll).sql, /blocks b/);
  assert.match(build("steps", withAll).sql, /u\.timezone/);

  for (const type of Object.keys(audienceQueries)) {
    const { sql } = build(type, without);
    assert.doesNotMatch(sql, /reminderSettings|blocks b|u\.timezone/, type);
  }
});

test("parameters are bound in SQL order", () => {
  const caps = { userTimezone: true, settings: true, blocks: true, log: true };
  assert.deepEqual(build("meal", caps).params, ["Europe/Oslo", ["Europe/Oslo", "Bad/Zone"], "Lunch", "2026-09-14 00:00:00", 0, 1000]);
  assert.deepEqual(build("steps", caps).params, ["2026-09-14", "Europe/Oslo", ["Europe/Oslo", "Bad/Zone"], 0, 1000]);
  assert.deepEqual(build("workout", caps).params.slice(2), ["MON", "Mon", ["morning"], 0, 1000]);
  assert.deepEqual(build("partners", caps).params, ["Europe/Oslo", ["Europe/Oslo", "Bad/Zone"], 0, 1000]);
  // Paging cursor and page size are always the last two parameters.
  for (const type of Object.keys(audienceQueries)) {
    assert.deepEqual(audienceQueries[type]({ caps, zoneValues: ["UTC"], defaultTimeZone: "UTC" }, ARGS[type], 42, 7).params.slice(-2), [42, 7], type);
  }
  assert.deepEqual(build("calories", { ...caps, userTimezone: false }).params, [
    "2026-09-14 00:00:00", "2026-09-15 00:00:00", "2026-09-14 00:00:00", "2026-09-15 00:00:00", 0, 1000,
  ]);
});

test("the zone query maps blank time zones to the default", () => {
  const { sql, params } = zoneQuery("Europe/Oslo");
  assert.match(sql, /COALESCE\(NULLIF\(TRIM\(u\.timezone\), ''\), \?\)/);
  assert.deepEqual(params, ["Europe/Oslo"]);
});
