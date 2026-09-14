// Push notification copy. Pure functions: easy to test and to change without touching SQL.
// `data.type` must be one the app routes in App.js navigateFromPush.
import { CALORIE_SUMMARY, PARTNER_DIGEST, normalizePreferredTime } from "./definitions.js";

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
