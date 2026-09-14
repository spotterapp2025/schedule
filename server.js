// Spotter schedule worker: time-zone-aware workout, step, meal, calorie and partner reminders. See README.md.
//   npm start                     run on a schedule
//   npm run once                  run one tick now and exit
//   npm run dry-run               one tick, log what would be sent, send nothing
//   node server.js --once --dry-run --at=2026-09-14T07:05:00+02:00   simulate a moment in time
import "dotenv/config";
import { ConfigError, loadConfig } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { createWorker } from "./src/worker.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});

let worker;
try {
  worker = await createWorker(config, { logger });
} catch (err) {
  logger.error("Could not start the schedule worker (is the database reachable?)", { error: err?.message });
  process.exit(1);
}

if (config.once) {
  let exitCode = 0;
  try {
    const summary = await worker.runTick();
    logger.info(config.dryRun ? "Dry run finished (nothing was sent)" : "Single run finished", summary);
    if (summary.errors) exitCode = 1;
  } catch {
    exitCode = 1;
  } finally {
    await worker.close();
  }
  process.exit(exitCode);
} else {
  worker.start();
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, finishing the current tick and stopping`);
    try {
      await worker.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
