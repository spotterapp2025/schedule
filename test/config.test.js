import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";

const env = { DATABASE_HOST: "localhost", DATABASE_USER: "spotter", DATABASE: "spotter", REMINDER_DEFAULT_TIMEZONE: "Europe/Oslo" };

test("database settings are required", () => {
  assert.throws(() => loadConfig({}, []), (err) => err instanceof ConfigError && /DATABASE_HOST, DATABASE_USER, DATABASE/.test(err.message));
});

test("sensible defaults", () => {
  const config = loadConfig(env, []);
  assert.equal(config.db.port, 3306);
  assert.equal(config.defaultTimeZone, "Europe/Oslo");
  assert.equal(config.graceMinutes, 30);
  assert.equal(config.tickCron, "*/5 * * * *");
  assert.equal(config.healthPort, 0);
  assert.deepEqual([config.dryRun, config.once, config.at], [false, false, null]);
});

test("invalid time zones and grace periods are rejected at startup", () => {
  assert.throws(() => loadConfig({ ...env, REMINDER_DEFAULT_TIMEZONE: "Oslo" }, []), ConfigError);
  assert.throws(() => loadConfig({ ...env, REMINDER_GRACE_MINUTES: "2" }, []), ConfigError);
});

test("command-line flags", () => {
  const config = loadConfig(env, ["--once", "--dry-run", "--at=2026-09-14T07:05:00+02:00"]);
  assert.equal(config.once, true);
  assert.equal(config.dryRun, true);
  assert.equal(config.at.toISOString(), "2026-09-14T05:05:00.000Z");
  assert.throws(() => loadConfig(env, ["--at=2026-09-14T07:05:00Z"]), /only be used together with --once/);
  assert.throws(() => loadConfig(env, ["--once", "--at=tomorrow"]), ConfigError);
  assert.equal(loadConfig({ ...env, DRY_RUN: "true" }, []).dryRun, true);
});
