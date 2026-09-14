import { test } from "node:test";
import assert from "node:assert/strict";
import { Expo } from "expo-server-sdk";
import { checkReceipts } from "../src/push/receipts.js";
import { createMemoryClaimStore } from "../src/reminders/claims.js";
import { silentLogger, token } from "./helpers.js";

test("records receipts, removes unregistered devices and gives up after a day", async () => {
  let clock = Date.parse("2026-09-14T10:00:00Z");
  const store = createMemoryClaimStore({ now: () => clock });
  const claims = await store.claimMany([1, 2, 3].map((n) => ({ userID: n, kind: "meal:lunch", localDate: "2026-09-14", token: token(n) })));
  await store.complete(claims.map((c) => ({ claim: c, status: "sent", ticketID: `ticket-${c.userID}`, pushToken: c.token })));

  const expo = new Expo();
  const asked = [];
  expo.getPushNotificationReceiptsAsync = async (ids) => {
    asked.push(...ids);
    return {
      "ticket-1": { status: "ok" },
      "ticket-2": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    };
  };
  const cleared = [];
  const sender = { clearTokens: async (tokens) => void cleared.push(...tokens) };

  // Not old enough yet: nothing is checked.
  clock += 5 * 60 * 1000;
  assert.equal((await checkReceipts({ expo, store, sender, logger: silentLogger })).checked, 0);

  clock += 25 * 60 * 60 * 1000;
  const summary = await checkReceipts({ expo, store, sender, logger: silentLogger });
  assert.deepEqual(summary, { checked: 3, delivered: 1, failed: 1, unknown: 1 });
  assert.deepEqual(asked.sort(), ["ticket-1", "ticket-2", "ticket-3"]);
  assert.deepEqual(cleared, [token(2)]);
  assert.deepEqual(await store.pendingReceipts({ olderThanMinutes: 15, limit: 10 }), []);
});

test("a receipts outage leaves tickets pending for the next run", async () => {
  let clock = Date.parse("2026-09-14T10:00:00Z");
  const store = createMemoryClaimStore({ now: () => clock });
  const [claim] = await store.claimMany([{ userID: 1, kind: "meal:lunch", localDate: "2026-09-14", token: token(1) }]);
  await store.complete([{ claim, status: "sent", ticketID: "ticket-1", pushToken: token(1) }]);
  clock += 30 * 60 * 1000;

  const expo = new Expo();
  expo.getPushNotificationReceiptsAsync = async () => {
    throw new Error("503");
  };
  const summary = await checkReceipts({ expo, store, sender: { clearTokens: async () => {} }, logger: silentLogger });
  assert.deepEqual(summary, { checked: 1, delivered: 0, failed: 0, unknown: 0 });
  assert.equal((await store.pendingReceipts({ olderThanMinutes: 15, limit: 10 })).length, 1);
});
