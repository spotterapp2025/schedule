// One scheduler tick: for each time zone with a reminder due, find the audience, claim, send, record.
import { dueReminders, dueStreakChecks } from "./definitions.js";
import { audienceQueries, streakAudienceQueries, zoneQuery } from "./audience.js";
import { LIMIT_HISTORY_DAYS, applyLimits, isLimited } from "./limits.js";
import {
  calorieSummary,
  mealReminder,
  partnerDigest,
  stepReminder,
  streakCelebration,
  streakReminder,
  streakWarning,
  workoutReminder,
} from "./messages.js";
import { isInQuietHours, localDateISO, localDayBoundsUtc, localTime, resolveZone, toDbClock, weekdayKey } from "../time.js";

export const PAGE_SIZE = 1000;

/**
 * @param {{db: any, store: any, sender: any, logger: any, capabilities: any,
 *          config: {defaultTimeZone: string, graceMinutes: number, dryRun?: boolean},
 *          now?: () => Date, pageSize?: number}} deps
 */
export function createReminderRunner({ db, store, sender, logger, capabilities, config, now = () => new Date(), pageSize = PAGE_SIZE }) {
  /** Raw time-zone values grouped by the zone they resolve to (invalid values fall back to the default). */
  async function zoneGroups(caps) {
    const fallback = config.defaultTimeZone;
    let rawValues = [fallback];
    if (caps.userTimezone) {
      const { sql, params } = zoneQuery(fallback);
      rawValues = (await db.query(sql, params)).map((row) => row.zone);
    }
    const groups = new Map();
    for (const raw of rawValues) {
      const zone = resolveZone(raw, fallback);
      if (!groups.has(zone)) groups.set(zone, []);
      groups.get(zone).push(raw);
    }
    return groups;
  }

  /** What to query and which message to build, per reminder type. */
  function plan(reminder, local, dbOffset) {
    switch (reminder.type) {
      case "meal": {
        const { start } = localDayBoundsUtc(local);
        return { args: { meal: reminder.slot.meal, since: toDbClock(start, dbOffset) }, build: () => mealReminder(reminder.slot) };
      }
      case "steps":
        return { args: { localDate: localDateISO(local) }, build: (row) => stepReminder(reminder.slot, row) };
      case "workout":
        return { args: { weekday: weekdayKey(local), preferredTimes: reminder.preferredTimes }, build: (row) => workoutReminder(row) };
      case "calories": {
        const { start, end } = localDayBoundsUtc(local);
        return { args: { start: toDbClock(start, dbOffset), end: toDbClock(end, dbOffset) }, build: (row) => calorieSummary(row) };
      }
      case "partners":
        return { args: {}, build: (row) => partnerDigest(row) };
      case "streakReminder":
      case "streakWarning":
      case "streakCelebrate": {
        const dates = { today: localDateISO(local), yesterday: localDateISO(local.minus({ days: 1 })) };
        const { start, end } = localDayBoundsUtc(local);
        const args = { localDate: dates.today, yesterday: dates.yesterday, start: toDbClock(start, dbOffset), end: toDbClock(end, dbOffset), window: reminder.window };
        const builders = { streakReminder, streakWarning, streakCelebrate: streakCelebration };
        const buildStreak = builders[reminder.type];
        return { args, build: (row) => buildStreak(row, dates) };
      }
      default:
        throw new Error(`Unknown reminder type "${reminder.type}"`);
    }
  }

  async function settle(results, summary) {
    const completed = [];
    const retry = [];
    for (const result of results) {
      const bucket = (summary.byKind[result.item.kind] ??= { sent: 0, failed: 0, retry: 0 });
      if (result.outcome === "sent") {
        summary.sent++;
        bucket.sent++;
        completed.push({ claim: result.item, status: config.dryRun ? "dry-run" : "sent", ticketID: result.ticketID ?? null, pushToken: result.item.token });
      } else if (result.outcome === "retry") {
        summary.retry++;
        bucket.retry++;
        retry.push(result.item.claimID);
      } else {
        summary.failed++;
        bucket.failed++;
        completed.push({ claim: result.item, status: "failed", error: result.error });
      }
    }
    if (completed.length) await store.complete(completed);
    if (retry.length) await store.release(retry);
  }

  /** Holds back candidates that would exceed the frequency limits (limits.js), counting them by reason. */
  async function withinLimits(candidates, summary) {
    const userIDs = candidates.filter((candidate) => isLimited(candidate.kind)).map((candidate) => candidate.userID);
    if (!userIDs.length) return candidates;
    const history = await store.recentHistory(userIDs, LIMIT_HISTORY_DAYS);
    const { allowed, held } = applyLimits(candidates, history);
    for (const { reason } of held) summary.limited[reason] = (summary.limited[reason] ?? 0) + 1;
    return allowed;
  }

  async function runReminder({ reminder, ctx, local, dbOffset, summary }) {
    const { args, build } = plan(reminder, local, dbOffset);
    const localDate = localDateISO(local);
    let cursor = 0;
    for (;;) {
      const query = audienceQueries[reminder.type] ?? streakAudienceQueries[reminder.type];
      const { sql, params } = query(ctx, args, cursor, pageSize);
      const rows = await db.query(sql, params);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].userID;

      const candidates = [];
      for (const row of rows) {
        if (isInQuietHours(local, row.quietStart, row.quietEnd)) {
          summary.skippedQuiet++;
          continue;
        }
        const content = build(row);
        if (!content) continue;
        candidates.push({
          userID: row.userID,
          token: row.token,
          kind: content.kind,
          localDate,
          limit: content.limit,
          message: { title: content.title, body: content.body, data: content.data },
        });
      }

      summary.candidates += candidates.length;
      const sendable = await withinLimits(candidates, summary);
      const claimed = await store.claimMany(sendable);
      summary.duplicates += sendable.length - claimed.length;
      if (claimed.length) await settle(await sender.send(claimed), summary);
      if (rows.length < pageSize) break;
    }
  }

  async function tick() {
    const caps = await capabilities.refreshIfStale();
    const at = now();
    const summary = { at: at.toISOString(), store: store.kind, zonesDue: 0, candidates: 0, sent: 0, failed: 0, retry: 0, duplicates: 0, skippedQuiet: 0, limited: {}, errors: 0, byKind: {} };

    let dbOffset = null;
    const getDbOffset = async () => {
      if (dbOffset === null) {
        const [row] = await db.query("/* clock */ SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offsetMinutes");
        dbOffset = Number(row?.offsetMinutes) || 0;
      }
      return dbOffset;
    };

    for (const [zone, zoneValues] of await zoneGroups(caps)) {
      const local = localTime(at, zone);
      const due = /** @type {any[]} */ (dueReminders(local, config.graceMinutes));
      if (caps.streaks) due.push(...dueStreakChecks(local, config.graceMinutes));
      if (!due.length) continue;
      summary.zonesDue++;
      const ctx = { caps, zoneValues, defaultTimeZone: config.defaultTimeZone };
      for (const reminder of due) {
        try {
          await runReminder({ reminder, ctx, local, dbOffset: await getDbOffset(), summary });
        } catch (err) {
          // One failing reminder type must not stop the others.
          summary.errors++;
          logger.error("Reminder run failed", { type: reminder.type, zone, error: err?.message });
        }
      }
    }
    return summary;
  }

  return { tick };
}
