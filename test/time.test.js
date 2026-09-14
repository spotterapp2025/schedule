import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { isInQuietHours, isSlotDue, localDateISO, localDayBoundsUtc, parseClock, resolveZone, toDbClock, weekdayKey } from "../src/time.js";

const at = (iso, zone = "Europe/Oslo") => DateTime.fromISO(iso, { zone });

test("resolveZone accepts IANA zones and falls back for missing or invalid values", () => {
  assert.equal(resolveZone("Europe/Oslo", "UTC"), "Europe/Oslo");
  assert.equal(resolveZone(" Asia/Ho_Chi_Minh ", "UTC"), "Asia/Ho_Chi_Minh");
  assert.equal(resolveZone("Mars/Base", "UTC"), "UTC");
  assert.equal(resolveZone("null", "UTC"), "UTC");
  assert.equal(resolveZone(null, "UTC"), "UTC");
});

test("parseClock reads HH:mm only", () => {
  assert.equal(parseClock("07:00"), 420);
  assert.equal(parseClock("23:59"), 1439);
  assert.equal(parseClock("7:00"), null);
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock(null), null);
});

test("a slot is due from its time until the grace period ends", () => {
  assert.equal(isSlotDue(at("2026-09-14T06:59"), "07:00", 30), false);
  assert.equal(isSlotDue(at("2026-09-14T07:00"), "07:00", 30), true);
  assert.equal(isSlotDue(at("2026-09-14T07:29"), "07:00", 30), true);
  assert.equal(isSlotDue(at("2026-09-14T07:30"), "07:00", 30), false);
});

test("quiet hours work within a day and across midnight", () => {
  assert.equal(isInQuietHours(at("2026-09-14T23:30"), "22:00", "07:00"), true);
  assert.equal(isInQuietHours(at("2026-09-14T06:59"), "22:00", "07:00"), true);
  assert.equal(isInQuietHours(at("2026-09-14T07:00"), "22:00", "07:00"), false);
  assert.equal(isInQuietHours(at("2026-09-14T14:00"), "13:00", "15:00"), true);
  assert.equal(isInQuietHours(at("2026-09-14T14:00"), null, null), false);
  assert.equal(isInQuietHours(at("2026-09-14T14:00"), "09:00", "09:00"), false);
});

test("local day bounds follow the user's zone, including DST changes", () => {
  const oslo = localDayBoundsUtc(at("2026-09-14T07:05"));
  assert.equal(oslo.start.toISO(), "2026-09-13T22:00:00.000Z");
  assert.equal(oslo.end.toISO(), "2026-09-14T22:00:00.000Z");

  const springForward = localDayBoundsUtc(at("2026-03-08T12:00", "America/New_York"));
  assert.equal(springForward.end.diff(springForward.start, "hours").hours, 23);
});

test("toDbClock formats instants on the database clock", () => {
  const start = DateTime.fromISO("2026-09-13T22:00:00Z");
  assert.equal(toDbClock(start, 120), "2026-09-14 00:00:00");
  assert.equal(toDbClock(start, 0), "2026-09-13 22:00:00");
});

test("weekday keys and local dates match the app's workout plan format", () => {
  assert.equal(weekdayKey(at("2026-09-13T12:00")), "SUN");
  assert.equal(weekdayKey(at("2026-09-14T12:00")), "MON");
  // 23:30 UTC on the 13th is already the 14th in Oslo.
  assert.equal(localDateISO(DateTime.fromISO("2026-09-13T23:30:00Z").setZone("Europe/Oslo")), "2026-09-14");
});
