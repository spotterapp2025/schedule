// Time-zone helpers. Reminders are scheduled on each user's local clock, not the server's.
import { DateTime, IANAZone } from "luxon";

export const WEEKDAY_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** A valid IANA zone name, or `fallback` for missing/invalid values. */
export function resolveZone(zone, fallback) {
  const name = typeof zone === "string" ? zone.trim() : "";
  return name && IANAZone.isValidZone(name) ? name : fallback;
}

/** "HH:mm" → minutes after midnight, or null when malformed. */
export function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** @param {Date} instant @param {string} zone */
export function localTime(instant, zone) {
  return DateTime.fromJSDate(instant, { zone });
}

/** @param {DateTime} local */
export function minutesOfDay(local) {
  return local.hour * 60 + local.minute;
}

/**
 * A slot is due from its start until `graceMinutes` later, so a worker that was restarted (or a skipped tick)
 * still sends it. The reminder log makes sure it goes out only once.
 * @param {DateTime} local @param {string} clock "HH:mm" @param {number} graceMinutes
 */
export function isSlotDue(local, clock, graceMinutes) {
  const slot = parseClock(clock);
  if (slot === null) return false;
  const minutes = minutesOfDay(local);
  return minutes >= slot && minutes < slot + graceMinutes;
}

/** Quiet hours may cross midnight (for example 22:00–07:00). Missing or equal bounds mean no quiet hours. */
export function isInQuietHours(local, quietStart, quietEnd) {
  const start = parseClock(quietStart);
  const end = parseClock(quietEnd);
  if (start === null || end === null || start === end) return false;
  const minutes = minutesOfDay(local);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** @param {DateTime} local */
export function localDateISO(local) {
  return local.toFormat("yyyy-MM-dd");
}

/** @param {DateTime} local */
export function weekdayKey(local) {
  return WEEKDAY_KEYS[local.weekday - 1];
}

/** The user's local calendar day as UTC instants (handles 23/25-hour DST days). @param {DateTime} local */
export function localDayBoundsUtc(local) {
  const start = local.startOf("day");
  return { start: start.toUTC(), end: start.plus({ days: 1 }).toUTC() };
}

/**
 * Format a UTC instant on the database clock (UTC + offsetMinutes). `meals.eatenAt` is written with NOW(), and
 * TIMESTAMP columns are compared in the session time zone, so both use this clock.
 * @param {DateTime} utc @param {number} offsetMinutes
 */
export function toDbClock(utc, offsetMinutes) {
  return utc.toUTC().plus({ minutes: offsetMinutes }).toFormat("yyyy-MM-dd HH:mm:ss");
}
