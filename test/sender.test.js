import { test } from "node:test";
import assert from "node:assert/strict";
import { Expo } from "expo-server-sdk";
import { MAX_PUSH_BYTES, buildPushMessage, createPushSender } from "../src/push/sender.js";
import { createFakeDb, silentLogger, token } from "./helpers.js";

const item = (n, overrides = {}) => ({
  claimID: n,
  userID: n,
  token: token(n),
  kind: "meal:lunch",
  localDate: "2026-09-14",
  message: { title: "Lunch", body: "Time to eat", data: { type: "achievement-macro" } },
  ...overrides,
});

/** Real Expo client (for its chunking) with the network call replaced. */
function stubExpo(handler) {
  const expo = new Expo();
  const requests = [];
  expo.sendPushNotificationsAsync = async (chunk) => {
    requests.push(chunk);
    return handler(chunk);
  };
  return { expo, requests };
}

test("sends in batches of 100 and maps each ticket back to its reminder", async () => {
  const { expo, requests } = stubExpo((chunk) => chunk.map((message) => ({ status: "ok", id: `ticket:${message.to}` })));
  const db = createFakeDb();
  const results = await createPushSender({ expo, db, logger: silentLogger }).send(Array.from({ length: 150 }, (_, i) => item(i + 1)));

  assert.deepEqual(requests.map((chunk) => chunk.length), [100, 50]);
  assert.equal(results.length, 150);
  assert.ok(results.every((r) => r.outcome === "sent" && r.ticketID === `ticket:${r.item.token}`));
  assert.equal(requests[0][0].channelId, "default");
  assert.equal(db.calls.length, 0);
});

test("removes unregistered tokens, retries rate-limited messages", async () => {
  const { expo } = stubExpo(() => [
    { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } },
    { status: "ok", id: "t3" },
  ]);
  const db = createFakeDb();
  const results = await createPushSender({ expo, db, logger: silentLogger }).send([item(1), item(2), item(3)]);

  assert.deepEqual(results.map((r) => r.outcome), ["failed", "retry", "sent"]);
  assert.deepEqual(db.calls.map((c) => c.params), [[[token(1)]]]);
});

test("a failed request marks the batch for retry instead of dropping it", async () => {
  const { expo } = stubExpo(() => {
    throw new Error("socket hang up");
  });
  const results = await createPushSender({ expo, db: createFakeDb(), logger: silentLogger }).send([item(1), item(2)]);
  assert.deepEqual(results.map((r) => r.outcome), ["retry", "retry"]);
});

test("invalid tokens are never sent and are cleared", async () => {
  const { expo, requests } = stubExpo((chunk) => chunk.map(() => ({ status: "ok", id: "t" })));
  const db = createFakeDb();
  const results = await createPushSender({ expo, db, logger: silentLogger }).send([item(1, { token: "Error: not a token" }), item(2)]);

  assert.deepEqual(results.map((r) => [r.item.userID, r.outcome]), [[1, "failed"], [2, "sent"]]);
  assert.equal(requests[0].length, 1);
  assert.deepEqual(db.calls[0].params, [["Error: not a token"]]);
});

test("dry run sends nothing and changes nothing", async () => {
  const { expo, requests } = stubExpo(() => []);
  const db = createFakeDb();
  const results = await createPushSender({ expo, db, logger: silentLogger, dryRun: true }).send([item(1), item(2, { token: "bad" })]);
  assert.equal(requests.length, 0);
  assert.equal(db.calls.length, 0);
  assert.deepEqual(results.map((r) => r.outcome), ["failed", "sent"]);
});

test("oversized payloads keep only the notification type", () => {
  const message = buildPushMessage(token(1), { title: "t", body: "b", data: { type: "notifications", blob: "x".repeat(MAX_PUSH_BYTES) } });
  assert.deepEqual(message.data, { type: "notifications" });
  assert.deepEqual(buildPushMessage(token(1), { title: "t", body: "b" }).data, {});
});
