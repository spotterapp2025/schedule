// Push notification copy. Pure functions: easy to test and to change without touching SQL.
// `data.type` must be one the app routes in App.js navigateFromPush.
import {
  CALORIE_SUMMARY,
  MACRO_COMPLETION_RATIO,
  PARTNER_DIGEST,
  STREAK_LIMITS,
  STREAK_MILESTONES,
  WORKOUT_CHECK_IN,
  normalizePreferredTime,
} from "./definitions.js";

const format = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/** Trimmed text, or "" for empty values and the "null"/"undefined" strings the API stores for missing text. */
export function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text !== "null" && text !== "undefined" ? text : "";
}

export function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function mealReminder(slot) {
  return { kind: slot.kind, title: slot.title, body: slot.body, data: { type: "achievement-macro" } };
}

/**
 * @param {{kind: string, first?: boolean}} slot
 * @param {{steps?: number|string|null, stepGoal?: number|string|null}} progress
 */
export function stepReminder(slot, { steps, stepGoal }) {
  const goal = positiveNumber(stepGoal);
  const count = Math.max(0, Math.round(Number(steps) || 0));
  const data = { type: "achievement-step" };

  if (!goal) {
    // Ask once a day instead of at every step check-in.
    if (!slot.first) return null;
    return {
      kind: "steps:no-goal",
      title: "🏃 Step Goal Reminder",
      body: "You haven’t set a daily step goal yet. Set one to start tracking your progress!",
      data,
    };
  }
  if (count >= goal) {
    // One kind for the whole day, so the congratulations is sent once, not at every check-in.
    return { kind: "steps:goal", title: "🏅 Step goal reached", body: `Amazing! You’ve hit your ${format(goal)}-step goal today!`, data };
  }
  if (count === 0) {
    return { kind: slot.kind, title: "🏃 Step Goal Reminder", body: "You’ve got 0 steps so far — let’s take a short walk to get started! 🚶‍♂️", data };
  }
  return {
    kind: slot.kind,
    title: "🏃 Step Goal Progress",
    body: `You’re doing great! Only ${format(goal - count)} steps left to reach your goal today 🎯`,
    data,
  };
}

/** @param {{workoutType?: string|null, preferredTime?: string|null}} plan */
export function workoutReminder({ workoutType, preferredTime }) {
  const when = normalizePreferredTime(preferredTime);
  const type = cleanText(workoutType).toLowerCase();
  const session = [when === "unset" ? "" : when, type, /workout/.test(type) ? "" : "workout"].filter(Boolean).join(" ");
  return {
    kind: "workout:day",
    title: "💪 It's workout day",
    body: `Your ${session} is on today's plan. Want a training partner? Tap to find someone to work out with.`,
    // Home is Discover, where users find workout partners.
    data: { type: "new-feature", navigation: "Home" },
  };
}

/** @param {{target?: number|string|null, eaten?: number|string|null, burned?: number|string|null}} totals */
export function calorieSummary({ target, eaten, burned }) {
  const goal = positiveNumber(target);
  const intake = Math.max(0, Number(eaten) || 0);
  const out = Math.max(0, Number(burned) || 0);
  const base = { kind: CALORIE_SUMMARY.kind, data: { type: "achievement-macro" } };

  if (intake === 0 && out === 0) {
    return { ...base, title: "🍽️ Don't forget to log today", body: "You haven't logged any meals today. Add them now to keep your calorie tracking accurate." };
  }
  if (!goal) {
    return { ...base, title: "📊 Today's calories", body: `You ate ${format(intake)} kcal and burned ${format(out)} kcal today. Set a calorie goal to see what's left.` };
  }
  const remaining = Math.round(goal - intake + out);
  if (remaining >= 0) {
    return { ...base, title: "📊 Today's calories", body: `You ate ${format(intake)} of ${format(goal)} kcal and burned ${format(out)} kcal — ${format(remaining)} kcal left today.` };
  }
  return { ...base, title: "📊 Today's calories", body: `You're ${format(-remaining)} kcal over today's goal (${format(intake)} eaten, ${format(out)} burned). Tomorrow's a fresh start 💪` };
}

/** @param {{pendingRequests?: number|string|null, newLikes?: number|string|null}} counts */
export function partnerDigest({ pendingRequests, newLikes }) {
  const requests = Math.max(0, Math.trunc(Number(pendingRequests) || 0));
  const likes = Math.max(0, Math.trunc(Number(newLikes) || 0));
  if (!requests && !likes) return null;
  const parts = [];
  if (requests) parts.push(plural(requests, "connection request", "connection requests"));
  if (likes) parts.push(plural(likes, "new like", "new likes"));
  return {
    kind: PARTNER_DIGEST.kind,
    title: "🤝 Workout partners are waiting",
    body: `You have ${parts.join(" and ")} waiting. Say hi and plan a session together!`,
    data: { type: "notifications" },
  };
}

/**
 * "Did you work out today?" — opens the Workout Calendar, where today's workout can be marked as completed.
 * @param {{goal?: number|string|null, completedThisWeek?: number|string|null}} row
 */
export function workoutCheckIn({ goal, completedThisWeek }) {
  const target = positiveNumber(goal);
  const done = Math.max(0, Math.trunc(Number(completedThisWeek) || 0));
  const weekly = target ? ` You've logged ${done} of ${Math.min(7, Math.round(target))} workouts this week.` : "";
  return {
    kind: WORKOUT_CHECK_IN.kind,
    title: "💪 Did you work out today?",
    body: `Tap to mark today's workout as completed.${weekly}`,
    data: { type: "workout-check-in" },
  };
}

// ---- Streaks ----
// One message covers both streaks, so each stage (reminder, warning, celebration) reaches a user at most once a day.
// Encouraging, never shaming. Every streak push opens the app's Streaks screen.
const STREAK_LABELS = { steps: "step", macro: "nutrition" };
const switchedOn = (value) => value === undefined || value === null || Number(value) === 1;

/**
 * Both streaks from an audience row. `length` is the streak including today when today is complete; `atRisk` means
 * the streak ran through yesterday and today isn't complete yet. Mirrors api/streaks/streakRules.js requiredForGoal.
 * @param {Record<string, any>} row @param {{today: string, yesterday: string}} dates
 */
export function streakSnapshot(row, { today, yesterday }) {
  const one = (type, goalValue, progressValue, current, lastCompleted, stateAge, enabled) => {
    const goal = positiveNumber(goalValue);
    const required = goal ? Math.ceil(type === "macro" ? goal * MACRO_COMPLETION_RATIO : goal) : null;
    const value = Math.max(0, Number(progressValue) || 0);
    const completed = required !== null && value >= required;
    const streak = Math.max(0, Math.trunc(Number(current) || 0));
    // streakState may have been written before today was completed: then it still counts up to yesterday.
    const throughYesterday = lastCompleted === yesterday && streak > 0;
    const length = lastCompleted === today ? streak : throughYesterday ? streak + (completed ? 1 : 0) : completed ? 1 : 0;
    return {
      type,
      enabled: switchedOn(enabled),
      required,
      value,
      remaining: required === null ? null : Math.max(0, required - value),
      completed,
      atRisk: switchedOn(enabled) && required !== null && !completed && throughYesterday,
      length,
      stateAge: stateAge === null || stateAge === undefined ? null : Number(stateAge),
    };
  };
  return {
    steps: one("steps", row.stepGoal, row.steps, row.stepsStreak, row.stepsLastCompleted, row.stepsStateAge, row.stepStreakOn),
    macro: one("macro", row.kcalTarget, row.eaten, row.macroStreak, row.macroLastCompleted, row.macroStateAge, row.macroStreakOn),
  };
}

const streakData = (streaks) => ({ type: "streak", streak: streaks.length === 1 ? streaks[0].type : "all" });
/** Extra information for limits.js; not sent. */
const limitInfo = (streaks) => ({ topics: streaks.map((s) => s.type) });

/** @param {Record<string, any>} row @param {{today: string, yesterday: string}} dates */
export function streakReminder(row, dates) {
  const { steps, macro } = streakSnapshot(row, dates);
  const atRisk = [steps, macro].filter((s) => s.atRisk);
  if (!atRisk.length) return null;
  const base = { kind: "streak:reminder", data: streakData(atRisk), limit: limitInfo(atRisk) };
  if (atRisk.length === 2) {
    return {
      ...base,
      title: "🔥 Keep your streaks going",
      body: `Your ${steps.length}-day step streak and ${macro.length}-day nutrition streak are waiting: ${format(steps.remaining)} steps to go and today's meals to log.`,
    };
  }
  const [only] = atRisk;
  if (only.type === "steps") {
    return { ...base, title: "👟 Keep your step streak going", body: `You're on a ${only.length}-day step streak. ${format(only.remaining)} steps to go today.` };
  }
  return { ...base, title: "🥗 Keep your nutrition streak going", body: `You're on a ${only.length}-day nutrition streak. Log today's meals to keep it going.` };
}

/** @param {Record<string, any>} row @param {{today: string, yesterday: string}} dates */
export function streakWarning(row, dates, minStreak = STREAK_LIMITS.warningMinStreak) {
  const { steps, macro } = streakSnapshot(row, dates);
  const atRisk = [steps, macro].filter((s) => s.atRisk && s.length >= minStreak);
  if (!atRisk.length) return null;
  const base = { kind: "streak:warning", data: streakData(atRisk), limit: limitInfo(atRisk) };
  if (atRisk.length === 2) {
    return {
      ...base,
      title: "⏳ Your streaks are waiting",
      body: `A little more today keeps your ${steps.length}-day step streak and ${macro.length}-day nutrition streak going.`,
    };
  }
  const [only] = atRisk;
  if (only.type === "steps") {
    const body =
      only.value > 0
        ? `You're close—${format(only.remaining)} steps left to keep your ${only.length}-day streak.`
        : `There's still time for a walk today to keep your ${only.length}-day step streak.`;
    return { ...base, title: "⏳ Your step streak is waiting", body };
  }
  return { ...base, title: "⏳ Your nutrition streak is waiting", body: `Complete today's meal log to protect your ${only.length}-day streak.` };
}

/**
 * A streak of 2+ days that grew today, once the completion has settled. Milestone lengths get the milestone message
 * when milestones are on (kind streak:milestone); otherwise the regular celebration when celebrations are on.
 * @param {Record<string, any>} row @param {{today: string, yesterday: string}} dates
 */
export function streakCelebration(row, dates, settleMinutes = STREAK_LIMITS.celebrationSettleMinutes) {
  const { steps, macro } = streakSnapshot(row, dates);
  const settled = (s) => s.stateAge === null || s.stateAge >= settleMinutes;
  const grew = [steps, macro].filter((s) => s.enabled && s.completed && s.length >= 2 && settled(s));
  if (!grew.length) return null;

  const milestones = switchedOn(row.milestones) ? grew.filter((s) => STREAK_MILESTONES.includes(s.length)) : [];
  if (milestones.length) {
    const top = Math.max(...milestones.map((s) => s.length));
    const body =
      milestones.length === 2
        ? `Your ${steps.length}-day step streak and ${macro.length}-day nutrition streak are complete!`
        : `Your ${milestones[0].length}-day ${STREAK_LABELS[milestones[0].type]} streak is complete!`;
    return { kind: "streak:milestone", title: `🏅 ${top}-day milestone`, body, data: streakData(milestones), limit: limitInfo(milestones) };
  }

  if (!switchedOn(row.celebrations)) return null;
  const base = { kind: "streak:celebrate", data: streakData(grew), limit: limitInfo(grew) };
  if (grew.length === 2) {
    return {
      ...base,
      title: "🔥 Both streaks grew today",
      body: `${steps.length} days of step goals and ${macro.length} days of logged meals. Nice work!`,
    };
  }
  const [only] = grew;
  const body =
    only.type === "steps"
      ? `Step goal done today — your step streak is now ${only.length} days. Nice work!`
      : `Meals logged today — your nutrition streak is now ${only.length} days. Nice work!`;
  return { ...base, title: `🔥 ${only.length} days in a row`, body };
}
