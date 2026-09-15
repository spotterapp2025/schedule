// Frequency limits: applied after messages are built and before they're claimed, using what each user already received
// recently (reminderLog, or the in-memory store). Keeps streak notifications from piling on top of each other and on
// top of the regular reminders. Pure functions: the runner loads the history.
import { STREAK_LIMITS } from "./definitions.js";

/** Days of history limitReason needs. */
export const LIMIT_HISTORY_DAYS = STREAK_LIMITS.celebrationEveryDays;

const STREAK_DAILY = new Set(["streak:reminder", "streak:warning", "streak:celebrate"]);
const STREAK_NUDGES = new Set(["streak:reminder", "streak:warning"]);
const CELEBRATIONS = new Set(["streak:celebrate", "streak:milestone"]);
const STEP_CHECK_IN = /^steps:(morning|afternoon|evening)$/;

/** Whether a kind is subject to a limit (so the runner only loads history when it matters). */
export function isLimited(kind) {
  return STREAK_DAILY.has(kind) || CELEBRATIONS.has(kind) || STEP_CHECK_IN.test(kind) || kind === "steps:goal";
}

/**
 * Why this notification must not be sent now, or null when it may be.
 * @param {{kind: string, localDate: string, limit?: {topics?: string[]}}} candidate
 * @param {{kind: string, localDate: string, ageMinutes: number}[]} history this user's recent notifications (failed sends excluded)
 * @param {typeof STREAK_LIMITS} [limits]
 * @returns {null | "recent-push" | "after-reminder" | "daily-cap" | "celebrated-recently" | "already-congratulated" | "streak-reminder-recent" | "streak-celebrated"}
 */
export function limitReason(candidate, history, limits = STREAK_LIMITS) {
  const { kind, localDate } = candidate;
  const today = history.filter((entry) => entry.localDate === localDate);
  const within = (minutes, match) => history.some((entry) => entry.ageMinutes < minutes && match(entry));

  if (STREAK_NUDGES.has(kind)) {
    if (within(limits.minGapMinutes, () => true)) return "recent-push";
    if (kind === "streak:warning" && today.some((entry) => entry.kind === "streak:reminder" && entry.ageMinutes < limits.warningAfterReminderMinutes)) {
      return "after-reminder";
    }
  }
  if (STREAK_DAILY.has(kind) && today.filter((entry) => STREAK_DAILY.has(entry.kind)).length >= limits.maxPerDay) return "daily-cap";
  if (kind === "streak:celebrate") {
    if (within(limits.celebrationEveryDays * 24 * 60, (entry) => CELEBRATIONS.has(entry.kind))) return "celebrated-recently";
    const topics = candidate.limit?.topics ?? [];
    if (topics.length === 1 && topics[0] === "steps" && today.some((entry) => entry.kind === "steps:goal")) return "already-congratulated";
  }
  if (STEP_CHECK_IN.test(kind) && within(limits.stepCheckInGapMinutes, (entry) => STREAK_NUDGES.has(entry.kind))) return "streak-reminder-recent";
  if (kind === "steps:goal" && today.some((entry) => CELEBRATIONS.has(entry.kind))) return "streak-celebrated";
  return null;
}

/**
 * Splits candidates into those that may be sent and those held back. A candidate whose kind was already sent today is
 * left for the claim store to reject, so it's counted as a duplicate rather than a limit.
 * @template {{userID: number | string, kind: string, localDate: string, limit?: {topics?: string[]}}} T
 * @param {T[]} candidates
 * @param {{userID: number | string, kind: string, localDate: string, ageMinutes: number | string}[]} historyRows
 * @returns {{allowed: T[], held: {candidate: T, reason: string}[]}}
 */
export function applyLimits(candidates, historyRows, limits = STREAK_LIMITS) {
  const byUser = new Map();
  for (const row of historyRows ?? []) {
    const key = String(row.userID);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push({ kind: row.kind, localDate: row.localDate, ageMinutes: Number(row.ageMinutes) || 0 });
  }
  const allowed = [];
  const held = [];
  for (const candidate of candidates) {
    const history = byUser.get(String(candidate.userID)) ?? [];
    const duplicate = history.some((entry) => entry.kind === candidate.kind && entry.localDate === candidate.localDate);
    const reason = !duplicate && isLimited(candidate.kind) ? limitReason(candidate, history, limits) : null;
    if (reason) held.push({ candidate, reason });
    else allowed.push(candidate);
  }
  return { allowed, held };
}
