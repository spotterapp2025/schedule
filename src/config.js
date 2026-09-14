// Worker configuration: environment variables plus command-line flags. Validated once at startup.
import { IANAZone } from "luxon";

export class ConfigError extends Error {}

const REQUIRED_DB_VARS = ["DATABASE_HOST", "DATABASE_USER", "DATABASE"];

function toInt(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) ? number : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export function systemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} argv
 */
export function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  const missing = REQUIRED_DB_VARS.filter((name) => !env[name]);
  if (missing.length) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")} (see .env.example).`);
  }

  // Users without a saved time zone get reminders on this clock. Defaults to the server's zone, as before.
  const defaultTimeZone = env.REMINDER_DEFAULT_TIMEZONE || systemTimeZone();
  if (!IANAZone.isValidZone(defaultTimeZone)) {
    throw new ConfigError(`REMINDER_DEFAULT_TIMEZONE "${defaultTimeZone}" is not a valid IANA time zone (for example "Europe/Oslo").`);
  }

  const graceMinutes = toInt(env.REMINDER_GRACE_MINUTES, 30);
  if (graceMinutes < 5 || graceMinutes > 120) {
    throw new ConfigError("REMINDER_GRACE_MINUTES must be between 5 and 120.");
  }

  const flags = new Set(argv);
  const once = flags.has("--once");
  const atArg = argv.find((arg) => arg.startsWith("--at="));
  let at = null;
  if (atArg) {
    if (!once) throw new ConfigError("--at can only be used together with --once.");
    at = new Date(atArg.slice("--at=".length));
    if (Number.isNaN(at.getTime())) {
      throw new ConfigError("--at must be an ISO date-time, for example --at=2026-09-14T07:05:00+02:00");
    }
  }

  return {
    db: {
      host: env.DATABASE_HOST,
      port: toInt(env.DATABASE_PORT, 3306),
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD ?? "",
      database: env.DATABASE,
      connectionLimit: toInt(env.DATABASE_POOL_SIZE, 5),
    },
    defaultTimeZone,
    graceMinutes,
    tickCron: env.SCHEDULE_TICK_CRON || "*/5 * * * *",
    maintenanceCron: env.SCHEDULE_MAINTENANCE_CRON || "*/15 * * * *",
    receiptDelayMinutes: toInt(env.RECEIPT_DELAY_MINUTES, 15),
    logRetentionDays: toInt(env.REMINDER_LOG_RETENTION_DAYS, 60),
    expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined,
    healthPort: toInt(env.HEALTH_PORT, 0),
    logLevel: env.LOG_LEVEL || "info",
    dryRun: flags.has("--dry-run") || toBool(env.DRY_RUN),
    once,
    at,
  };
}
