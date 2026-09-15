// What gets sent and when, on the user's local clock.
import { isSlotDue, minutesOfDay, parseClock, weekdayKey } from "../time.js";

/** reminderSettings column that switches each reminder type on or off (missing row = on). */
export const PREFERENCE_COLUMNS = {
  meal: "mealReminders",
  steps: "stepReminders",
  workout: "workoutReminders",
  calories: "calorieSummary",
  partners: "partnerDigest",
};

// Times and copy kept from the original meal reminders.
export const MEAL_SLOTS = [
  { kind: "meal:breakfast", meal: "Breakfast", time: "07:00", title: "☀️ Morning Check-in", body: "Good morning! Have you had breakfast yet?" },
  { kind: "meal:lunch", meal: "Lunch", time: "11:50", title: "🍱 Lunchtime Reminder", body: "It's lunch o'clock! Don’t forget to grab something tasty 🍛" },
  { kind: "meal:dinner", meal: "Dinner", time: "18:15", title: "🍽️ Dinner Time", body: "Evening’s here — time for dinner and to relax a bit 🌙" },
];

export const STEP_SLOTS = [
  { kind: "steps:morning", time: "10:30", first: true },
  { kind: "steps:afternoon", time: "14:30" },
  { kind: "steps:evening", time: "19:30" },
];

/**
 * Workout-day reminder time for each workoutPlan.preferredTime. The app's windows start at 6:00, 12:00 and 18:00;
 * reminders land shortly before, and away from the meal reminders.
 */
export const WORKOUT_TIMES = { morning: "06:45", afternoon: "11:30", evening: "17:30", unset: "08:00" };

export const CALORIE_SUMMARY = { kind: "calories:summary", time: "20:30" };
export const PARTNER_DIGEST = { kind: "partners:weekly", time: "18:00", weekday: "SUN" };

// Streak notifications (api migration 0008). Streaks are calculated by the API (api/streaks/streakRules.js) and
// cached in streakState; these values must match that file (test/streaks.test.js checks).
export const STREAK_TYPES = ["steps", "macro"];
export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100];
export const MACRO_COMPLETION_RATIO = 0.8;
/** Daily reminder at the user's own time (reminderSettings.streakReminderTime), within this range. */
export const STREAK_REMINDER = { defaultTime: "19:00", earliest: "06:00", latest: "22:00" };
/** Evening "streak at risk" warning. */
export const STREAK_WARNING = { time: "21:30" };
/** Completed days are celebrated during these local hours (once settled, see STREAK_LIMITS). */
export const STREAK_CELEBRATION_HOURS = { from: "07:00", until: "23:00" };

/**
 * How often streak notifications may reach one user (applied in limits.js). On top of this, one message covers both
 * streaks, so a user gets at most one reminder, one warning and one celebration or milestone per day.
 */
export const STREAK_LIMITS = Object.freeze({
  /** Streak reminders, warnings and celebrations per local day. Milestones don't count and are always sent. */
  maxPerDay: 2,
  /** No streak reminder or warning within this many minutes of any other push to the same user. */
  minGapMinutes: 90,
  /** The warning is skipped when the streak reminder went out less than this long ago. */
  warningAfterReminderMinutes: 120,
  /** Only streaks of at least this many days get the at-risk warning; shorter ones just get the reminder. */
  warningMinStreak: 3,
  /** Ordinary "your streak grew" celebrations at most once per this many days (milestones reset the clock too). */
  celebrationEveryDays: 3,
  /** Celebrate only once the day has been complete this long, so the push doesn't land while the app is still open. */
  celebrationSettleMinutes: 30,
  /** Regular step check-ins are skipped within this many minutes after a streak reminder or warning. */
  stepCheckInGapMinutes: 90,
  /** The "Did you work out today?" check-in waits this long after any other push (and is sent later in its window). */
  workoutCheckInGapMinutes: 20,
});

/**
 * "Did you work out today?" on the user's planned workout days (workoutPlan.workoutDays) at their own time
 * (reminderSettings.workoutCheckInTime), skipped once today is marked as completed. Api migrations 0009 and 0010.
 */
export const WORKOUT_CHECK_IN = { kind: "workout:check-in", defaultTime: "20:00", earliest: "06:00", latest: "22:30" };

/**
 * The check-in is due for users whose time falls in `window` (minutes after midnight; the last `graceMinutes`), so a
 * restarted worker or a held-back reminder still goes out. The reminder log sends it once per day.
 * @param {import("luxon").DateTime} local
 * @param {number} graceMinutes
 */
export function dueWorkoutCheckIns(local, graceMinutes) {
  const minutes = minutesOfDay(local);
  const earliest = parseClock(WORKOUT_CHECK_IN.earliest);
  const latest = parseClock(WORKOUT_CHECK_IN.latest);
  if (minutes < earliest || minutes >= latest + graceMinutes) return [];
  return [{ type: "workoutCheckIn", weekday: weekdayKey(local), window: { from: Math.max(earliest, minutes - graceMinutes + 1), to: Math.min(latest, minutes) } }];
}

/**
 * Streak checks due at this local time. Only run when the database has the streak tables (capabilities.streaks).
 * - streakReminder: users whose reminder time falls in `window` (minutes after midnight; the last `graceMinutes`).
 * - streakWarning: once, at STREAK_WARNING.time.
 * - streakCelebrate: every tick during STREAK_CELEBRATION_HOURS; the reminder log and limits keep it rare.
 * @param {import("luxon").DateTime} local
 * @param {number} graceMinutes
 */
export function dueStreakChecks(local, graceMinutes) {
  const due = [];
  const minutes = minutesOfDay(local);
  const earliest = parseClock(STREAK_REMINDER.earliest);
  const latest = parseClock(STREAK_REMINDER.latest);
  if (minutes >= earliest && minutes < latest + graceMinutes) {
    due.push({ type: "streakReminder", window: { from: Math.max(earliest, minutes - graceMinutes + 1), to: Math.min(latest, minutes) } });
  }
  if (isSlotDue(local, STREAK_WARNING.time, graceMinutes)) due.push({ type: "streakWarning" });
  if (minutes >= parseClock(STREAK_CELEBRATION_HOURS.from) && minutes < parseClock(STREAK_CELEBRATION_HOURS.until)) {
    due.push({ type: "streakCelebrate" });
  }
  return due;
}

/** "morning" | "afternoon" | "evening" | "unset" (the app stores missing values as the text "null"). */
export function normalizePreferredTime(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return key === "morning" || key === "afternoon" || key === "evening" ? key : "unset";
}

/**
 * Every reminder due at this local time.
 * @param {import("luxon").DateTime} local
 * @param {number} graceMinutes
 */
export function dueReminders(local, graceMinutes) {
  const due = [];
  for (const slot of MEAL_SLOTS) {
    if (isSlotDue(local, slot.time, graceMinutes)) due.push({ type: "meal", slot });
  }
  for (const slot of STEP_SLOTS) {
    if (isSlotDue(local, slot.time, graceMinutes)) due.push({ type: "steps", slot });
  }
  const preferredTimes = Object.entries(WORKOUT_TIMES)
    .filter(([, time]) => isSlotDue(local, time, graceMinutes))
    .map(([key]) => key);
  if (preferredTimes.length) due.push({ type: "workout", preferredTimes });
  if (isSlotDue(local, CALORIE_SUMMARY.time, graceMinutes)) due.push({ type: "calories", slot: CALORIE_SUMMARY });
  if (weekdayKey(local) === PARTNER_DIGEST.weekday && isSlotDue(local, PARTNER_DIGEST.time, graceMinutes)) {
    due.push({ type: "partners", slot: PARTNER_DIGEST });
  }
  return due;
}
