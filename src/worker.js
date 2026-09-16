// Wires the worker together: database, Expo, claim store, reminder runner, receipts, cron and health check.
import { Expo } from "expo-server-sdk";
import { createDb } from "./db.js";
import { createLogger } from "./logger.js";
import { startHealthServer } from "./health.js";
import { startJobs } from "./scheduler.js";
import { createCapabilities } from "./reminders/capabilities.js";
import { createClaimStore, createMemoryClaimStore } from "./reminders/claims.js";
import { createReminderRunner } from "./reminders/runner.js";
import { createPushSender } from "./push/sender.js";
import { checkReceipts } from "./push/receipts.js";
import { createLinkExpiryJob } from "./mealPlanShares/linkExpiry.js";
import { createChallengeJob } from "./challenges/challengeJob.js";

// A tick runs every 5 minutes by default; no successful tick for this long means something is wrong.
const STALE_AFTER_MS = 20 * 60 * 1000;

/** @param {ReturnType<typeof import("./config.js").loadConfig>} config */
export async function createWorker(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const db = overrides.db ?? createDb(config.db);
  const expo = overrides.expo ?? new Expo({ accessToken: config.expoAccessToken });

  const capabilities = createCapabilities(db, { logger });
  await capabilities.refresh(); // fails fast if the database is unreachable

  const now = config.at ? () => config.at : () => new Date();
  // A dry run must not write claims, or it would block today's real reminders. The memory store uses the worker's
  // clock, so frequency limits in an --at simulation are measured at the simulated time.
  const memory = createMemoryClaimStore({ now: () => now().getTime() });
  const store = config.dryRun ? memory : createClaimStore({ db, capabilities, memory });
  const sender = createPushSender({ expo, db, logger, dryRun: config.dryRun });
  const runner = createReminderRunner({ db, store, sender, logger, capabilities, config, now });
  // Share Meal Plan: tell owners when a QR code expires or reaches its usage limit.
  const linkExpiry = createLinkExpiryJob({ db, sender, logger, capabilities, now, dryRun: config.dryRun });

  async function runMealPlanLinkExpiry() {
    await capabilities.refreshIfStale();
    return linkExpiry.run();
  }

  // Challenges: started, milestone and completed notices, and final results.
  const challengeJob = createChallengeJob({ db, sender, logger, capabilities, now, dryRun: config.dryRun, defaultTimeZone: config.defaultTimeZone });

  async function runChallenges() {
    await capabilities.refreshIfStale();
    return challengeJob.run();
  }

  const state = { startedAt: Date.now(), lastTickAt: null, lastTickOk: null, lastError: null, lastSummary: null };

  async function runTick() {
    try {
      const summary = await runner.tick();
      Object.assign(state, { lastTickAt: Date.now(), lastTickOk: summary.errors === 0, lastError: null, lastSummary: summary });
      if (summary.candidates || summary.errors) logger.info("Reminder tick", summary);
      else logger.debug("Reminder tick: nothing due", { at: summary.at });
      return summary;
    } catch (err) {
      Object.assign(state, { lastTickAt: Date.now(), lastTickOk: false, lastError: err?.message });
      logger.error("Reminder tick failed", { error: err?.message });
      throw err;
    }
  }

  async function runMaintenance() {
    if (config.dryRun) return;
    const receipts = await checkReceipts({ expo, store, sender, logger, olderThanMinutes: config.receiptDelayMinutes });
    if (receipts.checked) logger.info("Push receipts checked", receipts);
    await store.prune(config.logRetentionDays);
  }

  function status() {
    const last = state.lastTickAt ?? state.startedAt;
    const healthy = state.lastTickOk !== false && Date.now() - last < STALE_AFTER_MS;
    return {
      healthy,
      dryRun: config.dryRun,
      store: store.kind,
      capabilities: capabilities.current(),
      startedAt: new Date(state.startedAt).toISOString(),
      lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
      lastError: state.lastError,
      lastSummary: state.lastSummary,
    };
  }

  let jobs = null;
  let health = null;

  return {
    runTick,
    runMaintenance,
    runMealPlanLinkExpiry,
    runChallenges,
    status,
    start() {
      jobs = startJobs(
        [
          { name: "reminders", cronTime: config.tickCron, run: runTick },
          { name: "maintenance", cronTime: config.maintenanceCron, run: runMaintenance },
          { name: "meal-plan-qr-expiry", cronTime: config.tickCron, run: runMealPlanLinkExpiry },
          { name: "challenges", cronTime: config.tickCron, run: runChallenges },
        ],
        logger
      );
      if (config.healthPort) health = startHealthServer({ port: config.healthPort, status, logger });
      logger.info("Schedule worker started", {
        defaultTimeZone: config.defaultTimeZone,
        tickCron: config.tickCron,
        graceMinutes: config.graceMinutes,
        dryRun: config.dryRun,
      });
    },
    async close() {
      await jobs?.stop();
      await health?.close();
      await db.close();
    },
  };
}
