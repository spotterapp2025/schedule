// What gets sent and when, on the user's local clock.
import { isSlotDue, weekdayKey } from "../time.js";

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
