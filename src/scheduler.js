// Cron jobs that never overlap: a tick still running when the next one is due is skipped.
import { CronJob } from "cron";

/**
 * @param {{name: string, cronTime: string, run: () => Promise<unknown>}[]} jobs
 * @param {{debug: Function, error: Function}} logger
 */
export function startJobs(jobs, logger) {
  const running = jobs.map(({ name, cronTime, run }) =>
    CronJob.from({
      name,
      cronTime,
      timeZone: "UTC",
      start: true,
      waitForCompletion: true,
      onTick: async () => {
        const startedAt = Date.now();
        try {
          await run();
        } catch (err) {
          logger.error(`Job "${name}" failed`, { error: err?.message });
        } finally {
          logger.debug(`Job "${name}" finished`, { ms: Date.now() - startedAt });
        }
      },
    })
  );

  return {
    /** Stop scheduling and wait (up to timeoutMs) for running ticks to finish. */
    async stop({ timeoutMs = 30_000 } = {}) {
      for (const job of running) job.stop();
      const deadline = Date.now() + timeoutMs;
      while (running.some((job) => job.isCallbackRunning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
