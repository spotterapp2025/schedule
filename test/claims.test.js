import { test } from "node:test";
import assert from "node:assert/strict";
import { createDbClaimStore, createMemoryClaimStore } from "../src/reminders/claims.js";
import { createFakeDb, token } from "./helpers.js";

const entry = (userID, kind = "meal:lunch", localDate = "2026-09-14") => ({ userID, kind, localDate, token: token(userID) });

test("memory store claims a reminder once per user, kind and local day", async () => {
  const store = createMemoryClaimStore();
  assert.equal((await store.claimMany([entry(1), entry(2)])).length, 2);
  assert.equal((await store.claimMany([entry(1)])).length, 0);
  assert.equal((await store.claimMany([entry(1, "meal:lunch", "2026-09-15")])).length, 1, "a new day is a new reminder");
  assert.equal((await store.claimMany([entry(1, "meal:dinner")])).length, 1);
});

test("released claims can be claimed again; completed ones cannot", async () => {
  const store = createMemoryClaimStore();
  const [first, second] = await store.claimMany([entry(1), entry(2)]);
  await store.release([first.claimID]);
  await store.complete([{ claim: second, status: "sent", ticketID: "t2", pushToken: second.token }]);
  await store.release([second.claimID]);
  assert.deepEqual((await store.claimMany([entry(1), entry(2)])).map((c) => c.userID), [1]);
});

test("database store inserts with a run ID and returns only the rows it created", async () => {
  /** @type {any[]} */
  let inserted = [];
  const db = createFakeDb({
    default: (params, sql) => {
      if (sql.startsWith("INSERT IGNORE")) {
        inserted = params[0];
        return { affectedRows: 1 };
      }
      if (sql.startsWith("SELECT id")) return [{ id: 10, userID: 1, kind: "meal:lunch" }]; // user 2 was already reminded
      return { affectedRows: 1 };
    },
  });
  const store = createDbClaimStore(db);

  const claimed = await store.claimMany([entry(1), entry(2), entry(1)]);
  assert.equal(inserted.length, 2, "duplicate entries are collapsed");
  const runID = inserted[0][3];
  assert.match(runID, /^[0-9a-f-]{36}$/);
  assert.deepEqual(db.calls[1].params, [runID]);
  assert.deepEqual(claimed.map((c) => [c.userID, c.claimID]), [[1, 10]]);

  await store.complete([{ claim: claimed[0], status: "sent", ticketID: "t1", pushToken: token(1) }]);
  const upsert = db.calls.at(-1);
  assert.match(upsert.sql, /AS new\s+ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(upsert.params[0][0], [10, 1, "meal:lunch", "2026-09-14", "sent", "t1", token(1), null]);

  const calls = db.calls.length;
  await store.release([]);
  await store.claimMany([]);
  assert.equal(db.calls.length, calls, "empty batches don't hit the database");
});

test("database store groups receipt updates by outcome", async () => {
  const db = createFakeDb();
  await createDbClaimStore(db).markReceipts([
    { id: 1, status: "delivered", error: null },
    { id: 2, status: "failed", error: "DeviceNotRegistered" },
    { id: 3, status: "delivered", error: null },
  ]);
  assert.deepEqual(db.calls.map((c) => c.params), [["delivered", null, [1, 3]], ["failed", "DeviceNotRegistered", [2]]]);
});
