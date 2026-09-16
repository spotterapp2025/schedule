// Detects which reminder features the database supports, so the worker runs before and after the
// api migration 0005_reminders is applied. Re-checked hourly: no restart needed once it's applied.
const NONE = Object.freeze({ userTimezone: false, settings: false, log: false, blocks: false, streaks: false, workoutCheckIn: false, mealPlanShares: false, challenges: false, healthDays: false });

/**
 * @param {{query: (sql: string, params?: unknown[]) => Promise<any>}} db
 * @param {{logger?: {info: Function, warn: Function}, refreshMs?: number, now?: () => number}} [options]
 */
export function createCapabilities(db, { logger, refreshMs = 60 * 60 * 1000, now = Date.now } = {}) {
  let caps = null;
  let checkedAt = 0;

  async function refresh() {
    const rows = await db.query(
      `/* capabilities */ SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND (TABLE_NAME IN ('reminderSettings', 'reminderLog', 'blocks', 'streakState', 'workoutCompletions', 'mealPlanShareLinks', 'challenges', 'challengeParticipants', 'healthDays') OR (TABLE_NAME = 'users' AND COLUMN_NAME = 'timezone'))`
    );
    const tables = new Set(rows.map((row) => row.tableName));
    const next = {
      userTimezone: rows.some((row) => row.tableName === "users" && row.columnName === "timezone"),
      settings: tables.has("reminderSettings"),
      log: tables.has("reminderLog"),
      blocks: tables.has("blocks"),
      // api migration 0008: streak state plus the streak columns on reminderSettings.
      streaks: tables.has("streakState") && rows.some((row) => row.tableName === "reminderSettings" && row.columnName === "streakReminderTime"),
      // api migrations 0009 + 0010: workout completions and the "Did you work out today?" settings.
      workoutCheckIn:
        tables.has("workoutCompletions") && rows.some((row) => row.tableName === "reminderSettings" && row.columnName === "workoutCheckInTime"),
      // api migration 0014: Share Meal Plan QR codes (expiry notices).
      mealPlanShares: tables.has("mealPlanShareLinks") && rows.some((row) => row.tableName === "mealPlanShareLinks" && row.columnName === "expiryNotifiedAt"),
      // api migration 0016: challenges (start / milestone / completion notices and final results).
      challenges: tables.has("challenges") && rows.some((row) => row.tableName === "challengeParticipants" && row.columnName === "finalResult"),
      // api migration 0017: calories imported from Apple Health / Health Connect count toward nutrition challenges.
      healthDays: rows.some((row) => row.tableName === "healthDays" && row.columnName === "dietaryKcal"),
    };
    if (!caps || JSON.stringify(caps) !== JSON.stringify(next)) {
      logger?.info("Database reminder features", next);
      if (!next.log) logger?.warn("reminderLog table missing: duplicate protection is in memory only until api migration 0005 runs");
    }
    caps = next;
    checkedAt = now();
    return caps;
  }

  return {
    current: () => caps ?? NONE,
    refresh,
    async refreshIfStale() {
      if (!caps || now() - checkedAt >= refreshMs) await refresh();
      return caps;
    },
  };
}
