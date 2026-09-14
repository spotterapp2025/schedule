import { test } from "node:test";
import assert from "node:assert/strict";
import { Expo } from "expo-server-sdk";
import { loadConfig } from "../src/config.js";
import { createWorker } from "../src/worker.js";
import { createFakeDb, silentLogger } from "./helpers.js";

test("the worker runs against a database that doesn't have the reminder tables yet", async () => {
  const db = createFakeDb({ capabilities: () => [], clock: () => [{ offsetMinutes: 0 }] });
  const config = loadConfig(
    { DATABASE_HOST: "localhost", DATABASE_USER: "spotter", DATABASE: "spotter", REMINDER_DEFAULT_TIMEZONE: "UTC", LOG_LEVEL: "silent" },
    ["--once", "--at=2026-09-14T07:05:00Z"]
  );
  const worker = await createWorker(config, { db, expo: new Expo(), logger: silentLogger });

  const summary = await worker.runTick();
  assert.equal(summary.store, "memory");
  assert.equal(summary.zonesDue, 1);
  const audienceCalls = db.calls.filter((c) => c.sql.includes("/* audience:"));
  assert.ok(audienceCalls.some((c) => c.sql.includes("audience:meal")));
  assert.ok(!audienceCalls.some((c) => c.sql.includes("reminderSettings")), "no settings table is queried before the migration");
  assert.equal(worker.status().healthy, true);

  await worker.close();
});
