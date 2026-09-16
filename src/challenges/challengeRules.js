// Challenges (the Racing feature): categories, validation, status, progress, ranking, ties, winners, milestones and
// permissions. Pure: no I/O, no imports. Three byte-identical copies (tests check):
//   api/challenges/challengeRules.js · app/screens/challenges/challengeRules.js · schedule/src/challenges/challengeRules.js
//
// Progress always comes from the app's existing data — nothing is tracked twice:
// - steps: a day counts when that day's steps (stepTracker) reach the step goal in effect that day (stepGoalHistory).
// - macro: a day counts when the meals logged that day reach 80% of the calorie target in effect (calorieTargetHistory).
// - workouts: a week (Monday–Sunday) counts when the days marked in the Workout calendar (workoutCompletions) reach the
//   weekly workout goal (workoutGoalHistory). Workout challenges run in whole weeks.
// These match streakRules.js and workoutRules.js (tests compare them).
//
// Dates are local calendar dates ("YYYY-MM-DD"). A challenge's dates use its creator's time zone; each participant's
// days are their own local days (as their streaks are).

export const CHALLENGE_CATEGORIES = Object.freeze(["steps", "macro", "workouts"]);
export const CHALLENGE_THEMES = Object.freeze(["meadow", "ocean", "sunset", "galaxy"]);
export const CHALLENGE_ICONS = Object.freeze(["trophy", "flame", "rocket", "medal", "star", "heart"]);

export const CHALLENGE_RULES = Object.freeze({
  nameMinLength: 3,
  nameMaxLength: 60,
  descriptionMaxLength: 300,
  /** Everyone invited or taking part, including the creator. */
  maxParticipants: 20,
  /** Upcoming and active challenges one person can be in at once. */
  maxOpenChallenges: 20,
  maxStartDaysAhead: 60,
  dayDuration: Object.freeze({ min: 3, max: 90 }),
  weekDuration: Object.freeze({ min: 1, max: 12 }),
  macroCompletionRatio: 0.8,
});

/** Personal progress notifications, as a share of the target. */
export const MILESTONE_PERCENTS = Object.freeze([50, 100]);

export const CHALLENGE_NOTIFICATION_TYPES = Object.freeze({
  invite: "challenge-invite",
  accepted: "challenge-accepted",
  declined: "challenge-declined",
  cancelled: "challenge-cancelled",
  started: "challenge-started",
  milestone: "challenge-milestone",
  completed: "challenge-completed",
});

export const CATEGORY_INFO = Object.freeze({
  steps: Object.freeze({
    title: "Step streak",
    icon: "footsteps",
    unit: "day",
    counts: "A day counts when you reach your daily step goal.",
  }),
  macro: Object.freeze({
    title: "Nutrition streak",
    icon: "nutrition",
    unit: "day",
    counts: "A day counts when the meals you log reach 80% of your calorie target.",
  }),
  workouts: Object.freeze({
    title: "Workout calendar streak",
    icon: "barbell",
    unit: "week",
    counts: "A week (Monday–Sunday) counts when the workouts in your Workout calendar reach your weekly workout goal.",
  }),
});

/** "1 day", "5 weeks". */
export function unitsLabel(category, count) {
  const unit = CATEGORY_INFO[category]?.unit ?? "day";
  return `${count} ${unit}${Number(count) === 1 ? "" : "s"}`;
}

/** How progress and the winner are decided, in plain words. */
export function winnerRules(category) {
  const info = CATEGORY_INFO[category] ?? CATEGORY_INFO.steps;
  const units = `${info.unit}s`;
  return [
    info.counts,
    `Your progress is your longest run of counted ${units} in a row during the challenge.`,
    `Whoever reaches the target first wins. People who reach it on the same ${info.unit} share the win.`,
    `If nobody reaches the target, the longest run wins — and with the same run, whoever got there first.`,
    "Anyone still level after that shares the position. A challenge needs at least 2 people to have a winner.",
  ];
}

// ---- dates ----

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const toUtc = (iso) => {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

/** @param {unknown} value */
export function isIsoDate(value) {
  const match = ISO_DATE.exec(typeof value === "string" ? value : "");
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === value;
}

/** @param {string} iso @param {number} days */
export function addDaysIso(iso, days) {
  return new Date(toUtc(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetweenIso(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** The Monday of the week a date belongs to. */
export function weekStartIso(date) {
  const weekday = new Date(toUtc(date)).getUTCDay(); // 0 = Sunday
  return addDaysIso(date, -((weekday + 6) % 7));
}

/** @param {unknown} zone */
export function isValidTimeZone(zone) {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date of an instant in a time zone. */
export function localDateInZone(instant, zone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    typeof instant === "number" ? new Date(instant) : instant
  );
  const part = (type) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The local hour (0–23) of an instant in a time zone. */
export function localHourInZone(instant, zone) {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(typeof instant === "number" ? new Date(instant) : instant)
    .find((p) => p.type === "hour")?.value;
  return Number(hour) % 24;
}

/** Days (steps, nutrition) or weeks (workouts) a challenge lasts. */
export function durationUnits(challenge) {
  const days = daysBetweenIso(challenge.startDate, challenge.endDate) + 1;
  return challenge.category === "workouts" ? Math.round(days / 7) : days;
}

/** upcoming | active | completed | cancelled, for `today` in the challenge's time zone. */
export function challengeStatus(challenge, today) {
  if (challenge?.status === "cancelled") return "cancelled";
  if (today < challenge.startDate) return "upcoming";
  if (today > challenge.endDate) return "completed";
  return "active";
}

/** Days left including today (active), days until the start (upcoming), otherwise 0. */
export function daysLeft(challenge, today) {
  const status = challengeStatus(challenge, today);
  if (status === "active") return daysBetweenIso(today, challenge.endDate) + 1;
  if (status === "upcoming") return daysBetweenIso(today, challenge.startDate);
  return 0;
}

// ---- validation ----

const toInt = (value) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
const isPositiveInt = (value) => Number.isInteger(value) && value > 0;
const sameUser = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);

/**
 * People to invite: unique user ids, not the creator.
 * @returns {{ok: boolean, value: number[] | null, error: string | null}}
 */
export function validateInvitees(input, creatorID, { required = true, max = CHALLENGE_RULES.maxParticipants - 1 } = {}) {
  if (input === undefined || input === null || (Array.isArray(input) && !input.length)) {
    return required ? { ok: false, value: null, error: "Choose at least one connection to invite." } : { ok: true, value: [], error: null };
  }
  const raw = Array.isArray(input) ? input.map(toInt) : null;
  if (!raw || !raw.every(isPositiveInt)) return { ok: false, value: null, error: "Some of the selected people aren't valid." };
  const unique = [...new Set(raw)];
  if (unique.some((id) => sameUser(id, creatorID))) return { ok: false, value: null, error: "You're already in your own challenge." };
  if (unique.length > max) return { ok: false, value: null, error: `A challenge can have at most ${CHALLENGE_RULES.maxParticipants} people.` };
  return { ok: true, value: unique, error: null };
}

/**
 * A new challenge. `today` is the creator's local date.
 * Steps and nutrition run in days; workout challenges run in whole weeks (start on a Monday, end on a Sunday).
 * @returns {{ok: boolean, value: any, errors: Record<string, string>}}
 */
export function validateChallengeInput(input, { today, creatorID }) {
  const body = input && typeof input === "object" ? input : {};
  const errors = /** @type {Record<string, string>} */ ({});
  const value = /** @type {Record<string, any>} */ ({});

  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < CHALLENGE_RULES.nameMinLength) errors.name = "Give the challenge a name (at least 3 characters).";
  else if (name.length > CHALLENGE_RULES.nameMaxLength) errors.name = `Keep the name to ${CHALLENGE_RULES.nameMaxLength} characters or fewer.`;
  else value.name = name;

  if (body.description === undefined || body.description === null || body.description === "") value.description = null;
  else if (typeof body.description !== "string") errors.description = "The description must be text.";
  else if (body.description.trim().length > CHALLENGE_RULES.descriptionMaxLength) {
    errors.description = `Keep the description to ${CHALLENGE_RULES.descriptionMaxLength} characters or fewer.`;
  } else value.description = body.description.trim() || null;

  if (!CHALLENGE_CATEGORIES.includes(body.category)) errors.category = "Choose a step, nutrition or workout streak.";
  else value.category = body.category;
  const weekly = value.category === "workouts";

  if (!isIsoDate(body.startDate)) errors.startDate = "Pick a start date.";
  if (!isIsoDate(body.endDate)) errors.endDate = "Pick an end date.";
  if (!errors.startDate && !errors.endDate && value.category) {
    const latestStart = addDaysIso(today, CHALLENGE_RULES.maxStartDaysAhead);
    if (weekly) {
      if (weekStartIso(body.startDate) !== body.startDate) errors.startDate = "Workout challenges start on a Monday.";
      else if (body.startDate < weekStartIso(today)) errors.startDate = "Start this week or later.";
      else if (body.startDate > latestStart) errors.startDate = `Start within the next ${CHALLENGE_RULES.maxStartDaysAhead} days.`;
      const days = daysBetweenIso(body.startDate, body.endDate) + 1;
      const { min, max } = CHALLENGE_RULES.weekDuration;
      if (days % 7 !== 0 || days < min * 7 || days > max * 7) errors.endDate = `Workout challenges last ${min} to ${max} whole weeks (ending on a Sunday).`;
    } else {
      if (body.startDate < today) errors.startDate = "Start today or later.";
      else if (body.startDate > latestStart) errors.startDate = `Start within the next ${CHALLENGE_RULES.maxStartDaysAhead} days.`;
      const days = daysBetweenIso(body.startDate, body.endDate) + 1;
      const { min, max } = CHALLENGE_RULES.dayDuration;
      if (days < min || days > max) errors.endDate = `Challenges last ${min} to ${max} days.`;
    }
    if (!errors.startDate && !errors.endDate) {
      value.startDate = body.startDate;
      value.endDate = body.endDate;
    }
  }

  const target = toInt(body.target);
  if (value.startDate && value.category) {
    const units = durationUnits(value);
    if (!isPositiveInt(target)) errors.target = `Set a target of at least 1 ${CATEGORY_INFO[value.category].unit}.`;
    else if (target > units) errors.target = `The target can be at most ${unitsLabel(value.category, units)} — the length of the challenge.`;
    else value.target = target;
  } else if (!isPositiveInt(target)) {
    errors.target = "Set a target.";
  }

  if (body.theme === undefined || body.theme === null || body.theme === "") value.theme = CHALLENGE_THEMES[0];
  else if (!CHALLENGE_THEMES.includes(body.theme)) errors.theme = "Choose one of the themes.";
  else value.theme = body.theme;

  if (body.icon === undefined || body.icon === null || body.icon === "") value.icon = "trophy";
  else if (!CHALLENGE_ICONS.includes(body.icon)) errors.icon = "Choose one of the icons.";
  else value.icon = body.icon;

  const invitees = validateInvitees(body.inviteeIDs, creatorID, { required: false });
  if (!invitees.ok) errors.inviteeIDs = /** @type {string} */ (invitees.error);
  else value.inviteeIDs = invitees.value;

  return Object.keys(errors).length ? { ok: false, value: null, errors } : { ok: true, value, errors };
}

// ---- progress ----

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/** The goal in effect on `date`: the newest change on or before it (earliest known before any change; fallback without history). */
export function goalForDate(history, date, fallbackGoal = null) {
  if (!history?.length) return positive(fallbackGoal);
  let goal = history[0].goal;
  for (const entry of history) {
    if (entry.effectiveDate > date) break;
    goal = entry.goal;
  }
  return positive(goal);
}

/** Workouts per week, 1–7, or null. */
export function normalizeWorkoutGoal(value) {
  if (value === null || value === undefined || value === "") return null;
  const goal = Math.round(Number(value));
  if (!Number.isFinite(goal) || goal < 1) return null;
  return Math.min(7, goal);
}

/** Whether a day's steps or calories complete it (as streakRules.isDayComplete). */
export function isDayComplete(category, value, goal) {
  const target = positive(goal);
  if (!target) return false;
  const required = category === "macro" ? Math.ceil(target * CHALLENGE_RULES.macroCompletionRatio) : Math.ceil(target);
  return (Number(value) || 0) >= required;
}

/** Meal calories in 15-minute UTC buckets → calories per local date (as streakRules.bucketsToDailyTotals). */
export function bucketsToDailyTotals(buckets, zone) {
  /** @type {Record<string, number>} */
  const totals = {};
  for (const row of buckets ?? []) {
    const seconds = Number(row.bucket);
    if (!Number.isFinite(seconds)) continue;
    const date = localDateInZone(seconds * 1000, zone);
    totals[date] = (totals[date] ?? 0) + (Number(row.kcal) || 0);
  }
  return totals;
}

/**
 * The days or weeks of a challenge that have started by `today` (all of them once it's over), each with the date it
 * finishes on (a day itself, or a week's Sunday).
 * @returns {{key: string, endsOn: string, inProgress: boolean}[]}
 */
export function elapsedUnits(challenge, today) {
  const last = today < challenge.endDate ? today : challenge.endDate;
  if (last < challenge.startDate) return [];
  const units = [];
  if (challenge.category === "workouts") {
    for (let week = challenge.startDate; week <= last; week = addDaysIso(week, 7)) {
      const endsOn = addDaysIso(week, 6);
      units.push({ key: week, endsOn, inProgress: today >= week && today < endsOn });
    }
  } else {
    for (let day = challenge.startDate; day <= last; day = addDaysIso(day, 1)) {
      units.push({ key: day, endsOn: day, inProgress: day === today });
    }
  }
  return units;
}

/**
 * One participant's progress.
 * @param {{category: string, target: number, startDate: string, endDate: string}} challenge
 * @param {{values?: Record<string, number>, dates?: string[], goalHistory?: {effectiveDate: string, goal: number}[], currentGoal?: number | null}} data
 *   steps / macro: values per local date; workouts: dates marked in the Workout calendar.
 * @param {string} today the participant's local date
 */
export function participantProgress(challenge, data, today) {
  const units = elapsedUnits(challenge, today);
  const history = data?.goalHistory ?? [];
  const weekly = challenge.category === "workouts";
  const workoutDates = weekly ? new Set(data?.dates ?? []) : null;

  let run = 0;
  let best = 0;
  let bestReachedOn = null;
  let reachedTargetOn = null;
  let completed = 0;
  let goalMissing = false;
  const runs = [];

  for (const unit of units) {
    let complete;
    if (weekly) {
      const goal = unit.inProgress
        ? normalizeWorkoutGoal(data?.currentGoal) ?? normalizeWorkoutGoal(goalForDate(history, today))
        : normalizeWorkoutGoal(goalForDate(history, unit.endsOn, data?.currentGoal));
      if (!goal) goalMissing = true;
      let count = 0;
      for (let i = 0; i < 7; i++) if (/** @type {Set<string>} */ (workoutDates).has(addDaysIso(unit.key, i))) count++;
      complete = !!goal && count >= goal;
    } else {
      const goal = goalForDate(history, unit.key, data?.currentGoal ?? null);
      if (!goal) goalMissing = true;
      complete = isDayComplete(challenge.category, data?.values?.[unit.key] ?? 0, goal);
    }

    run = complete ? run + 1 : 0;
    runs.push(run);
    if (complete) completed++;
    if (run > best) {
      best = run;
      bestReachedOn = unit.endsOn;
    }
    if (reachedTargetOn === null && run >= challenge.target) reachedTargetOn = unit.endsOn;
  }

  // Like streaks: the unit still in progress never breaks the current run.
  const lastIndex = runs.length - 1;
  const current = lastIndex < 0 ? 0 : runs[lastIndex] > 0 || !units[lastIndex].inProgress ? runs[lastIndex] : runs[lastIndex - 1] ?? 0;
  const percent = Math.min(100, Math.floor((best / Math.max(1, challenge.target)) * 100));
  return {
    best,
    current,
    completed,
    reachedTargetOn,
    bestReachedOn,
    percent,
    remaining: Math.max(0, challenge.target - best),
    goalMissing: goalMissing && completed === 0,
  };
}

/** Negative when `a` ranks above `b`, 0 when they're level (a tie). */
export function compareProgress(a, b) {
  const aReached = a.reachedTargetOn;
  const bReached = b.reachedTargetOn;
  if (aReached && bReached) return aReached === bReached ? 0 : aReached < bReached ? -1 : 1;
  if (aReached) return -1;
  if (bReached) return 1;
  if (a.best !== b.best) return b.best - a.best;
  if (a.best === 0 || a.bestReachedOn === b.bestReachedOn) return 0;
  return a.bestReachedOn < b.bestReachedOn ? -1 : 1;
}

/**
 * Standings with shared positions for ties ("1, 1, 3"). Level people are listed by days/weeks counted, then name.
 * @template {{userID: any, name?: string, progress: ReturnType<typeof participantProgress>}} T
 * @param {T[]} entries
 * @returns {(T & {rank: number, tied: boolean})[]}
 */
export function rankParticipants(entries) {
  const sorted = [...(entries ?? [])].sort(
    (a, b) =>
      compareProgress(a.progress, b.progress) ||
      b.progress.completed - a.progress.completed ||
      String(a.name ?? "").localeCompare(String(b.name ?? "")) ||
      String(a.userID).localeCompare(String(b.userID))
  );
  const ranked = [];
  sorted.forEach((entry, index) => {
    const previous = ranked[index - 1];
    const rank = previous && compareProgress(previous.progress, entry.progress) === 0 ? previous.rank : index + 1;
    ranked.push({ ...entry, rank, tied: false });
  });
  for (const entry of ranked) entry.tied = ranked.filter((other) => other.rank === entry.rank).length > 1;
  return ranked;
}

/** Everyone in first place — only with at least 2 participants and some progress. */
export function winnersOf(ranked) {
  if ((ranked ?? []).length < 2) return [];
  return ranked.filter((entry) => entry.rank === 1 && entry.progress.best > 0);
}

/** A participant's result once the challenge is over: won (alone or shared) | lost | none (no contest). */
export function outcomeFor(userID, ranked) {
  const winners = winnersOf(ranked);
  if (!winners.length) return "none";
  return winners.some((entry) => sameUser(entry.userID, userID)) ? "won" : "lost";
}

/** The milestone (50 or 100) to announce now, or null. `alreadyNotified` is the highest one sent before. */
export function milestoneToNotify(alreadyNotified, percent) {
  const reached = MILESTONE_PERCENTS.filter((milestone) => percent >= milestone && milestone > (Number(alreadyNotified) || 0));
  return reached.length ? reached[reached.length - 1] : null;
}

// ---- permissions (the API enforces these; the app uses them for display) ----

const deny = (status, code, message) => ({ ok: false, status, code, message });
const allow = { ok: true, status: 200, code: "ok", message: "" };

/** Anyone who created, joined or was invited to a challenge can see it; nobody else can tell it exists. */
export const canViewChallenge = (membership) => !!membership;

/** Only the creator invites, while the challenge hasn't ended or been cancelled. */
export function inviteDecision({ challenge, actorID, status }) {
  if (!challenge || !sameUser(challenge.creatorUserID, actorID)) return deny(403, "not_creator", "Only the person who created the challenge can invite people.");
  if (status === "cancelled") return deny(410, "cancelled", "This challenge was cancelled.");
  if (status === "completed") return deny(410, "completed", "This challenge has ended.");
  return allow;
}

/**
 * Whether one person can be invited. Declined or left people can be invited again; nobody gets two memberships.
 * @returns {{ok: true, reinvite: boolean} | {ok: false, reason: string, message: string}}
 */
export function inviteRecipientDecision({ toUserID, actorID, connected, existing, spotsLeft }) {
  if (sameUser(toUserID, actorID)) return { ok: false, reason: "self", message: "You're already in this challenge." };
  if (!connected) return { ok: false, reason: "not_connected", message: "You can only invite your connections." };
  if (existing?.status === "invited") return { ok: false, reason: "already_invited", message: "They haven't answered your invitation yet." };
  if (existing?.status === "accepted") return { ok: false, reason: "already_joined", message: "They're already in this challenge." };
  if (spotsLeft <= 0) return { ok: false, reason: "full", message: `A challenge can have at most ${CHALLENGE_RULES.maxParticipants} people.` };
  return { ok: true, reinvite: !!existing };
}

/** Accept or decline: only your own invitation, only before the challenge ends or is cancelled. */
export function respondDecision({ membership, userID, status, action, openChallenges = 0 }) {
  if (!membership || !sameUser(membership.userID, userID)) return deny(404, "not_found", "This invitation wasn't found.");
  if (membership.role === "creator") return deny(403, "creator", "You created this challenge.");
  if (status === "cancelled") return deny(410, "cancelled", "This challenge was cancelled.");
  if (status === "completed") return deny(410, "completed", "This challenge has already ended.");
  if (membership.status !== "invited") return deny(409, "already_answered", "You already answered this invitation.");
  if (action === "accept" && openChallenges >= CHALLENGE_RULES.maxOpenChallenges) {
    return deny(409, "too_many", `You can take part in up to ${CHALLENGE_RULES.maxOpenChallenges} challenges at a time.`);
  }
  return allow;
}

/** Participants can leave an upcoming or active challenge; the creator cancels it instead. */
export function leaveDecision({ membership, status }) {
  if (!membership || !["accepted", "invited"].includes(membership.status)) return deny(404, "not_found", "You're not in this challenge.");
  if (membership.role === "creator") return deny(403, "creator", "You created this challenge — cancel it instead.");
  if (status === "cancelled" || status === "completed") return deny(410, status, "This challenge is already over.");
  return allow;
}

/** The creator can cancel an upcoming or active challenge. It stays visible as cancelled, with no winner. */
export function cancelDecision({ challenge, actorID, status }) {
  if (!challenge || !sameUser(challenge.creatorUserID, actorID)) return deny(403, "not_creator", "Only the person who created the challenge can cancel it.");
  if (status === "cancelled") return deny(409, "cancelled", "This challenge is already cancelled.");
  if (status === "completed") return deny(410, "completed", "A finished challenge can't be cancelled.");
  return allow;
}

/**
 * The creator can delete a challenge for everyone when it was cancelled, or while it's upcoming and nobody else has
 * joined. Finished and running challenges with participants stay, so nobody loses their results.
 */
export function deleteDecision({ challenge, actorID, status, joinedOthers }) {
  if (!challenge || !sameUser(challenge.creatorUserID, actorID)) return deny(403, "not_creator", "Only the person who created the challenge can delete it.");
  if (status === "cancelled" || (status === "upcoming" && joinedOthers === 0)) return allow;
  return deny(409, "in_use", "Cancel the challenge first. Challenges people have joined can't be deleted while they run.");
}
