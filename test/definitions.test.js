import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { dueReminders, normalizePreferredTime } from "../src/reminders/definitions.js";

const at = (iso) => DateTime.fromISO(iso, { zone: "Europe/Oslo" });
const summarize = (due) => due.map((d) => (d.type === "workout" ? `workout:${d.preferredTimes.join(",")}` : d.slot.kind));

test("morning: breakfast and morning workout reminders are due", () => {
  assert.deepEqual(summarize(dueReminders(at("2026-09-14T07:05"), 30)), ["meal:breakfast", "workout:morning"]);
});

test("step check-ins and the evening calorie summary", () => {
  assert.deepEqual(summarize(dueReminders(at("2026-09-14T10:31"), 30)), ["steps:morning"]);
  assert.deepEqual(summarize(dueReminders(at("2026-09-14T20:30"), 30)), ["calories:summary"]);
});

test("the partner digest is sent on Sunday evenings only", () => {
  assert.deepEqual(summarize(dueReminders(at("2026-09-13T18:05"), 30)), ["partners:weekly"]); // Sunday
  assert.deepEqual(summarize(dueReminders(at("2026-09-14T18:05"), 30)), []); // Monday, before dinner
});

test("nothing is due between slots", () => {
  assert.deepEqual(dueReminders(at("2026-09-14T12:40"), 30), []);
  assert.deepEqual(dueReminders(at("2026-09-14T03:00"), 30), []);
});

test("preferred time values are normalised", () => {
  assert.equal(normalizePreferredTime("Evening "), "evening");
  assert.equal(normalizePreferredTime("null"), "unset");
  assert.equal(normalizePreferredTime(undefined), "unset");
});
