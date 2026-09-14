// Detects which reminder features the database supports, so the worker runs before and after the
// api migration 0005_reminders is applied. Re-checked hourly: no restart needed once it's applied.
const NONE = Object.freeze({ userTimezone: false, settings: false, log: false, blocks: false });

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
         AND (TABLE_NAME IN ('reminderSettings', 'reminderLog', 'blocks') OR (TABLE_NAME = 'users' AND COLUMN_NAME = 'timezone'))`
    );
    const tables = new Set(rows.map((row) => row.tableName));
    const next = {
      userTimezone: rows.some((row) => row.tableName === "users" && row.columnName === "timezone"),
      settings: tables.has("reminderSettings"),
      log: tables.has("reminderLog"),
      blocks: tables.has("blocks"),
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
