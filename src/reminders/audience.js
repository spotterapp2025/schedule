// Who should get each reminder. Every query:
// - only includes users who finished onboarding and have a push token (one token per user),
// - respects reminderSettings and the user's time zone when those exist (see capabilities.js),
// - pages by userID (`AND u.userID > ? ORDER BY u.userID LIMIT ?`, always the last two parameters),
// - starts with a /* tag */ comment so logs and tests can tell the queries apart.
// All values go through `?` placeholders.
import { PREFERENCE_COLUMNS } from "./definitions.js";

const LATEST_PLAN = "workoutPlan wp ON wp.workoutID = (SELECT MAX(w2.workoutID) FROM workoutPlan w2 WHERE w2.userID = u.userID)";
const PAGE = "AND u.userID > ? ORDER BY u.userID LIMIT ?";

/**
 * @typedef {{userTimezone: boolean, settings: boolean, log: boolean, blocks: boolean}} Capabilities
 * @typedef {{caps: Capabilities, zoneValues: string[], defaultTimeZone: string}} AudienceContext
 */

/** @param {AudienceContext} ctx @param {keyof typeof PREFERENCE_COLUMNS} preference */
function base({ caps, zoneValues, defaultTimeZone }, preference) {
  const where = ["u.isComplete = 1"];
  const params = [];
  if (caps.settings) where.push(`COALESCE(rs.${PREFERENCE_COLUMNS[preference]}, 1) = 1`);
  if (caps.userTimezone) {
    where.push("COALESCE(NULLIF(TRIM(u.timezone), ''), ?) IN (?)");
    params.push(defaultTimeZone, zoneValues);
  }
  return {
    columns: `u.userID, t.expoToken AS token, ${caps.settings ? "rs.quietStart, rs.quietEnd" : "NULL AS quietStart, NULL AS quietEnd"}`,
    from:
      "users u JOIN (SELECT userID, MAX(expoToken) AS expoToken FROM socketio WHERE expoToken IS NOT NULL AND expoToken <> '' GROUP BY userID) t ON t.userID = u.userID" +
      (caps.settings ? " LEFT JOIN reminderSettings rs ON rs.userID = u.userID" : ""),
    where: where.join(" AND "),
    params,
  };
}

function notBlocked(caps, otherUserColumn) {
  return caps.blocks
    ? ` AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blockerUserID = u.userID AND b.blockedUserID = ${otherUserColumn}) OR (b.blockerUserID = ${otherUserColumn} AND b.blockedUserID = u.userID))`
    : "";
}

export const audienceQueries = {
  /** Users who haven't logged this meal today. `since` = start of their local day on the DB clock. */
  meal(ctx, { meal, since }, cursor, limit) {
    const b = base(ctx, "meal");
    return {
      sql: `/* audience:meal */ SELECT ${b.columns} FROM ${b.from} WHERE ${b.where}
        AND NOT EXISTS (SELECT 1 FROM meals m WHERE m.userID = u.userID AND m.meal = ? AND m.eatenAt >= ?)
        ${PAGE}`,
      params: [...b.params, meal, since, cursor, limit],
    };
  },

  /** Step goal and today's steps (0 when nothing was synced yet — the old query skipped those users). */
  steps(ctx, { localDate }, cursor, limit) {
    const b = base(ctx, "steps");
    return {
      sql: `/* audience:steps */ SELECT ${b.columns}, wp.stepGoal, COALESCE(st.steps, 0) AS steps
        FROM ${b.from}
        LEFT JOIN ${LATEST_PLAN}
        LEFT JOIN stepTracker st ON st.userID = u.userID AND st.date = ?
        WHERE ${b.where} ${PAGE}`,
      params: [localDate, ...b.params, cursor, limit],
    };
  },

  /** Users whose plan includes today, grouped by the preferred times due now. */
  workout(ctx, { weekday, preferredTimes }, cursor, limit) {
    const b = base(ctx, "workout");
    const titleCase = weekday.charAt(0) + weekday.slice(1).toLowerCase();
    return {
      sql: `/* audience:workout */ SELECT ${b.columns}, wp.workoutType, wp.preferredTime
        FROM ${b.from}
        JOIN ${LATEST_PLAN}
        WHERE ${b.where}
        AND (JSON_CONTAINS(wp.workoutDays, JSON_QUOTE(?)) OR JSON_CONTAINS(wp.workoutDays, JSON_QUOTE(?)))
        AND (CASE WHEN LOWER(TRIM(wp.preferredTime)) IN ('morning', 'afternoon', 'evening') THEN LOWER(TRIM(wp.preferredTime)) ELSE 'unset' END) IN (?)
        ${PAGE}`,
      params: [...b.params, weekday, titleCase, preferredTimes, cursor, limit],
    };
  },

  /** Calorie goal, food eaten and calories burned during the user's local day (`start`/`end` on the DB clock). */
  calories(ctx, { start, end }, cursor, limit) {
    const b = base(ctx, "calories");
    return {
      sql: `/* audience:calories */ SELECT ${b.columns}, mc.kcal AS target,
          (SELECT COALESCE(SUM(m.sumKcal), 0) FROM meals m WHERE m.userID = u.userID AND m.eatenAt >= ? AND m.eatenAt < ?) AS eaten,
          (SELECT COALESCE(SUM(a.kcal), 0) FROM activityLogs a WHERE a.userID = u.userID AND a.createAt >= ? AND a.createAt < ?) AS burned
        FROM ${b.from}
        LEFT JOIN macro mc ON mc.macroID = (SELECT MAX(m2.macroID) FROM macro m2 WHERE m2.userID = u.userID)
        WHERE ${b.where} ${PAGE}`,
      params: [start, end, start, end, ...b.params, cursor, limit],
    };
  },

  /** Pending connection requests and likes from the last 7 days that haven't become a connection. */
  partners(ctx, _args, cursor, limit) {
    const b = base(ctx, "partners");
    return {
      sql: `/* audience:partners */ SELECT ${b.columns},
          (SELECT COUNT(*) FROM connection c WHERE c.toUserID = u.userID AND c.status = 'pending'${notBlocked(ctx.caps, "c.fromUserID")}) AS pendingRequests,
          (SELECT COUNT(*) FROM likes l WHERE l.toUserID = u.userID AND l.isActive = 1 AND l.createAt >= NOW() - INTERVAL 7 DAY
            AND NOT EXISTS (SELECT 1 FROM connection c2 WHERE (c2.fromUserID = l.fromUserID AND c2.toUserID = l.toUserID) OR (c2.fromUserID = l.toUserID AND c2.toUserID = l.fromUserID))${notBlocked(ctx.caps, "l.fromUserID")}) AS newLikes
        FROM ${b.from}
        WHERE ${b.where} AND u.userID > ?
        HAVING pendingRequests > 0 OR newLikes > 0
        ORDER BY u.userID LIMIT ?`,
      params: [...b.params, cursor, limit],
    };
  },
};

/** Distinct time-zone values (NULL/blank → default). Only called when users.timezone exists. */
export function zoneQuery(defaultTimeZone) {
  return {
    sql: "/* zones */ SELECT DISTINCT COALESCE(NULLIF(TRIM(u.timezone), ''), ?) AS zone FROM users u WHERE u.isComplete = 1",
    params: [defaultTimeZone],
  };
}
