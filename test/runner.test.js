import { test } from "node:test";
import assert from "node:assert/strict";
import { createReminderRunner } from "../src/reminders/runner.js";
import { createMemoryClaimStore } from "../src/reminders/claims.js";
import { createFakeDb, silentLogger, staticCapabilities, token } from "./helpers.js";

const FULL = { userTimezone: true, settings: true, log: false, blocks: true };
const config = { defaultTimeZone: "Europe/Oslo", graceMinutes: 30, dryRun: false };

/** @param {(item: any) => "sent" | "failed" | "retry"} [outcomeFor] */
function fakeSender(outcomeFor = () => "sent") {
  const batches = [];
  return {
    batches,
    async send(items) {
      batches.push(items);
      return items.map((item) => {
        const outcome = outcomeFor(item);
        return { item, outcome, ticketID: outcome === "sent" ? `ticket-${item.userID}` : null, error: outcome === "sent" ? undefined : "boom" };
      });
    },
    async clearTokens() {},
  };
}

function setup({ routes = {}, caps = FULL, sender = fakeSender(), start }) {
  let now = new Date(start);
  const db = createFakeDb({
    zones: () => [{ zone: "Europe/Oslo" }, { zone: "America/New_York" }, { zone: "Not/A_Zone" }],
    clock: () => [{ offsetMinutes: 120 }],
    ...routes,
  });
  const runner = createReminderRunner({
    db,
    store: createMemoryClaimStore(),
    sender,
    logger: silentLogger,
    capabilities: staticCapabilities(caps),
    config,
    now: () => now,
  });
  return { db, sender, runner, setNow: (iso) => (now = new Date(iso)) };
}

/** Return rows for the first page only (the cursor is the second-to-last parameter). */
const firstPage = (rows) => (params) => (params.at(-2) === 0 ? rows : []);
const sentKinds = (batches) => batches.flat().map((i) => `${i.userID}:${i.kind}`);

test("breakfast goes out on each user's local clock, once, and respects quiet hours", async () => {
  const { db, sender, runner } = setup({
    start: "2026-09-14T05:05:00Z", // 07:05 in Oslo, 01:05 in New York
    routes: {
      "audience:meal": firstPage([
        { userID: 1, token: token(1), quietStart: null, quietEnd: null },
        { userID: 2, token: token(2), quietStart: "22:00", quietEnd: "08:00" },
      ]),
    },
  });

  const first = await runner.tick();
  assert.equal(first.zonesDue, 1);
  assert.equal(first.sent, 1);
  assert.equal(first.skippedQuiet, 1);

  const [item] = sender.batches[0];
  assert.equal(item.kind, "meal:breakfast");
  assert.equal(item.localDate, "2026-09-14");
  assert.deepEqual(item.message.data, { type: "achievement-macro" });

  const mealCall = db.calls.find((c) => c.sql.includes("audience:meal"));
  // Invalid zones are grouped with the default zone; "since" is Oslo midnight on the DB clock (UTC+2).
  assert.deepEqual(mealCall.params.slice(0, 2), ["Europe/Oslo", ["Europe/Oslo", "Not/A_Zone"]]);
  assert.ok(mealCall.params.includes("Breakfast"));
  assert.ok(mealCall.params.includes("2026-09-14 00:00:00"));
  assert.ok(db.calls.some((c) => c.sql.includes("audience:workout")), "the 06:45 morning-workout slot is also due");

  const second = await runner.tick();
  assert.equal(second.sent, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(sender.batches.length, 1, "nothing is sent twice");
});

test("claims are released when Expo is unreachable, so the next tick retries", async () => {
  let failing = true;
  const { runner } = setup({
    sender: fakeSender(() => (failing ? "retry" : "sent")),
    start: "2026-09-14T05:05:00Z",
    routes: { "audience:meal": firstPage([{ userID: 1, token: token(1) }]) },
  });
  assert.equal((await runner.tick()).retry, 1);
  failing = false;
  assert.equal((await runner.tick()).sent, 1);
});

test("steps: nudge users with 0 steps, ask for a goal once, congratulate once", async () => {
  const rows = [
    { userID: 1, token: token(1), stepGoal: "10000", steps: 12000 },
    { userID: 2, token: token(2), stepGoal: "null", steps: 0 },
    { userID: 3, token: token(3), stepGoal: "8000", steps: 0 },
  ];
  const { sender, runner, setNow } = setup({ start: "2026-09-14T08:35:00Z", routes: { "audience:steps": firstPage(rows) } }); // 10:35 Oslo

  await runner.tick();
  assert.deepEqual(sentKinds(sender.batches), ["1:steps:goal", "2:steps:no-goal", "3:steps:morning"]);

  setNow("2026-09-14T12:35:00Z"); // 14:35 Oslo
  const afternoon = await runner.tick();
  assert.deepEqual(sentKinds(sender.batches.slice(1)), ["3:steps:afternoon"]);
  assert.equal(afternoon.duplicates, 1, "the goal congratulations isn't repeated");
});

test("calorie summary covers the user's local day on the database clock", async () => {
  const { db, sender, runner } = setup({
    start: "2026-09-14T18:35:00Z", // 20:35 Oslo
    routes: { "audience:calories": firstPage([{ userID: 1, token: token(1), target: "2000", eaten: 1500, burned: 300 }]) },
  });
  await runner.tick();
  const call = db.calls.find((c) => c.sql.includes("audience:calories"));
  assert.deepEqual(call.params.slice(0, 4), ["2026-09-14 00:00:00", "2026-09-15 00:00:00", "2026-09-14 00:00:00", "2026-09-15 00:00:00"]);
  assert.match(sender.batches[0][0].message.body, /800 kcal left today/);
});

test("the Sunday partner digest skips users with nothing new", async () => {
  const { sender, runner } = setup({
    start: "2026-09-13T16:05:00Z", // Sunday 18:05 Oslo
    routes: {
      "audience:partners": firstPage([
        { userID: 1, token: token(1), pendingRequests: 2, newLikes: 1 },
        { userID: 2, token: token(2), pendingRequests: 0, newLikes: 0 },
      ]),
    },
  });
  const summary = await runner.tick();
  assert.equal(summary.sent, 1);
  assert.equal(sender.batches[0][0].message.data.type, "notifications");
});

test("a failing reminder type doesn't stop the others", async () => {
  const { db, runner } = setup({
    start: "2026-09-14T05:05:00Z",
    routes: {
      "audience:meal": () => {
        throw new Error("db down");
      },
    },
  });
  const summary = await runner.tick();
  assert.equal(summary.errors, 1);
  assert.ok(db.calls.some((c) => c.sql.includes("audience:workout")));
});

test("pages through large audiences by userID", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ userID: i + 1, token: token(i + 1) }));
  const db = createFakeDb({ clock: () => [{ offsetMinutes: 0 }], "audience:meal": (params) => rows.filter((r) => r.userID > params.at(-2)).slice(0, params.at(-1)) });
  const sender = fakeSender();
  const runner = createReminderRunner({
    db,
    store: createMemoryClaimStore(),
    sender,
    logger: silentLogger,
    capabilities: staticCapabilities({ userTimezone: false, settings: false, log: false, blocks: false }),
    config: { ...config, defaultTimeZone: "UTC" },
    now: () => new Date("2026-09-14T11:55:00Z"),
    pageSize: 2,
  });
  const summary = await runner.tick();
  assert.equal(summary.sent, 3);
  assert.equal(db.calls.filter((c) => c.sql.includes("audience:meal")).length, 2);
  assert.ok(!db.calls.some((c) => c.sql.includes("/* zones */")), "without users.timezone no zone lookup is needed");
});
