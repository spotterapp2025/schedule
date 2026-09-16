// The tracking data a challenge's progress needs, for everyone in it at once (the same sources as the API's
// api/challenges/challengeData.js): steps + step goals, meals + calorie targets, or Workout calendar days + weekly goals.
// Calories imported from Apple Health / Health Connect (healthDays, api migration 0017) count too: a day's total is the
// higher of logged meals and imported calories.
import { addDaysIso, bucketsToDailyTotals, isValidTimeZone } from "./challengeRules.js";

const SOURCES = {
  steps: {
    history: `/* challenges:history */ SELECT userID, DATE_FORMAT(effectiveDate, '%Y-%m-%d') AS effectiveDate, stepGoal AS goal FROM stepGoalHistory WHERE userID IN (?) ORDER BY effectiveDate`,
    current: `/* challenges:current */ SELECT wp.userID, wp.stepGoal AS goal FROM workoutPlan wp
              WHERE wp.userID IN (?) AND wp.workoutID = (SELECT MAX(w2.workoutID) FROM workoutPlan w2 WHERE w2.userID = wp.userID)`,
  },
  macro: {
    history: `/* challenges:history */ SELECT userID, DATE_FORMAT(effectiveDate, '%Y-%m-%d') AS effectiveDate, kcal AS goal FROM calorieTargetHistory WHERE userID IN (?) ORDER BY effectiveDate`,
    current: `/* challenges:current */ SELECT m.userID, m.kcal AS goal FROM macro m
              WHERE m.userID IN (?) AND m.macroID = (SELECT MAX(m2.macroID) FROM macro m2 WHERE m2.userID = m.userID)`,
  },
  workouts: {
    history: `/* challenges:history */ SELECT userID, DATE_FORMAT(effectiveDate, '%Y-%m-%d') AS effectiveDate, workoutsPerWeek AS goal FROM workoutGoalHistory WHERE userID IN (?) ORDER BY effectiveDate`,
    current: `/* challenges:current */ SELECT wp.userID, wp.frequency AS goal FROM workoutPlan wp
              WHERE wp.userID IN (?) AND wp.workoutID = (SELECT MAX(w2.workoutID) FROM workoutPlan w2 WHERE w2.userID = wp.userID)`,
  },
};

const groupBy = (rows) => {
  const map = new Map();
  for (const row of rows ?? []) {
    const key = String(row.userID);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

/**
 * @param {{importedKcal?: boolean}} [options] importedKcal: the healthDays table exists
 * @returns {Promise<Map<string, {zone: string, data: any}>>}
 */
export async function loadProgressData(db, challenge, userIDs, defaultTimeZone, { importedKcal = false } = {}) {
  const result = new Map();
  const ids = [...new Set((userIDs ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return result;
  const source = SOURCES[challenge.category];
  const from = challenge.startDate;
  const to = challenge.endDate;

  const [users, history, current, raw, imported] = await Promise.all([
    db.query(`/* challenges:users */ SELECT userID, timezone FROM users WHERE userID IN (?)`, [ids]),
    db.query(source.history, [ids]),
    db.query(source.current, [ids]),
    challenge.category === "steps"
      ? db.query(`/* challenges:data */ SELECT userID, DATE_FORMAT(date, '%Y-%m-%d') AS day, steps FROM stepTracker WHERE userID IN (?) AND date BETWEEN ? AND ?`, [ids, from, to])
      : challenge.category === "macro"
        ? db.query(
            `/* challenges:data */ SELECT userID, FLOOR(UNIX_TIMESTAMP(eatenAt) / 900) * 900 AS bucket, SUM(sumKcal) AS kcal
             FROM meals WHERE userID IN (?) AND eatenAt >= ? AND eatenAt < ? GROUP BY userID, bucket`,
            [ids, addDaysIso(from, -1), addDaysIso(to, 2)]
          )
        : db.query(`/* challenges:data */ SELECT userID, DATE_FORMAT(workoutDate, '%Y-%m-%d') AS workoutDate FROM workoutCompletions WHERE userID IN (?) AND workoutDate BETWEEN ? AND ?`, [ids, from, to]),
    challenge.category === "macro" && importedKcal
      ? db.query(
          `/* challenges:imported */ SELECT userID, DATE_FORMAT(day, '%Y-%m-%d') AS day, MAX(dietaryKcal) AS kcal FROM healthDays
           WHERE userID IN (?) AND day BETWEEN ? AND ? AND dietaryKcal IS NOT NULL GROUP BY userID, day`,
          [ids, from, to]
        )
      : Promise.resolve([]),
  ]);

  const zones = new Map((users ?? []).map((row) => [String(row.userID), isValidTimeZone(row.timezone) ? String(row.timezone).trim() : defaultTimeZone]));
  const histories = groupBy(history);
  const currents = new Map((current ?? []).map((row) => [String(row.userID), Number(row.goal) || null]));
  const rawByUser = groupBy(raw);
  const importedByUser = groupBy(imported);

  for (const id of ids) {
    const key = String(id);
    const zone = zones.get(key) ?? defaultTimeZone;
    const rows = rawByUser.get(key) ?? [];
    const data = {
      goalHistory: (histories.get(key) ?? []).map((row) => ({ effectiveDate: row.effectiveDate, goal: Number(row.goal) })),
      currentGoal: currents.get(key) ?? null,
    };
    if (challenge.category === "steps") {
      data.values = {};
      for (const row of rows) data.values[row.day] = Math.max(data.values[row.day] ?? 0, Number(row.steps) || 0);
    } else if (challenge.category === "macro") {
      data.values = bucketsToDailyTotals(rows, zone);
      for (const row of importedByUser.get(key) ?? []) {
        const kcal = Number(row.kcal) || 0;
        if (kcal > (data.values[row.day] ?? 0)) data.values[row.day] = kcal;
      }
    } else {
      data.dates = rows.map((row) => row.workoutDate);
    }
    result.set(key, { zone, data });
  }
  return result;
}
