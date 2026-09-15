// Frequency limits for streak notifications and the reminders they overlap with. No database or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT_HISTORY_DAYS, applyLimits, isLimited, limitReason } from "../src/reminders/limits.js";
import { createDbClaimStore, createMemoryClaimStore } from "../src/reminders/claims.js";
import { createFakeDb, token } from "./helpers.js";

const DAY = "2026-09-14";
const candidate = (kind, extra = {}) => ({ userID: 1, kind, localDate: DAY, ...extra });
const sent = (kind, ageMinutes, localDate = DAY) => ({ kind, ageMinutes, localDate });

test("streak reminders and warnings keep a 90-minute gap after any other push", () => {
  assert.equal(limitReason(candidate("streak:reminder"), [sent("meal:dinner", 45)]), "recent-push");
  assert.equal(limitReason(candidate("streak:reminder"), [sent("meal:dinner", 95)]), null);
  assert.equal(limitReason(candidate("streak:warning"), [sent("calories:summary", 60)]), "recent-push");
});

test("the warning comes at least two hours after the reminder", () => {
  assert.equal(limitReason(candidate("streak:warning"), [sent("streak:reminder", 100)]), "after-reminder");
  assert.equal(limitReason(candidate("streak:warning"), [sent("streak:reminder", 150)]), null);
});

test("at most two streak pushes a day; milestones are always allowed", () => {
  const two = [sent("streak:reminder", 300), sent("streak:warning", 150)];
  assert.equal(limitReason(candidate("streak:celebrate", { limit: { topics: ["macro"] } }), two), "daily-cap");
  assert.equal(limitReason(candidate("streak:milestone"), two), null);
  const yesterday = [sent("streak:reminder", 1500, "2026-09-13"), sent("streak:warning", 1400, "2026-09-13")];
  assert.equal(limitReason(candidate("streak:reminder"), yesterday), null, "yesterday's pushes don't count");
});

test("ordinary celebrations at most every 3 days, and a milestone resets the clock", () => {
  const celebrate = candidate("streak:celebrate", { limit: { topics: ["steps"] } });
  assert.equal(limitReason(celebrate, [sent("streak:celebrate", 2 * 1440, "2026-09-12")]), "celebrated-recently");
  assert.equal(limitReason(celebrate, [sent("streak:milestone", 1440, "2026-09-13")]), "celebrated-recently");
  assert.equal(limitReason(celebrate, [sent("streak:celebrate", 3 * 1440 + 10, "2026-09-11")]), null);
});

test("the step goal congratulations and a streak celebration never both go out", () => {
  assert.equal(limitReason(candidate("streak:celebrate", { limit: { topics: ["steps"] } }), [sent("steps:goal", 200)]), "already-congratulated");
  assert.equal(limitReason(candidate("streak:celebrate", { limit: { topics: ["steps", "macro"] } }), [sent("steps:goal", 200)]), null);
  assert.equal(limitReason(candidate("steps:goal"), [sent("streak:milestone", 30)]), "streak-celebrated");
});

test("step check-ins pause after a streak reminder; other reminders are untouched", () => {
  assert.equal(limitReason(candidate("steps:evening"), [sent("streak:reminder", 25)]), "streak-reminder-recent");
  assert.equal(limitReason(candidate("steps:evening"), [sent("streak:reminder", 95)]), null);
  assert.equal(isLimited("meal:lunch"), false);
  assert.equal(isLimited("calories:summary"), false);
});

test("applyLimits reads each user's own history and leaves repeats to the claim store", () => {
  const candidates = [candidate("streak:reminder"), { ...candidate("streak:reminder"), userID: 2 }, { ...candidate("meal:lunch"), userID: 3 }];
  const history = [
    { userID: 1, ...sent("meal:dinner", 10) },
    { userID: 2, ...sent("streak:reminder", 5) },
  ];
  const { allowed, held } = applyLimits(candidates, history);
  assert.deepEqual(allowed.map((c) => c.userID), [2, 3]);
  assert.deepEqual(held.map((h) => [h.candidate.userID, h.reason]), [[1, "recent-push"]]);
});

test("claim stores return recent history without failed sends", async () => {
  let now = Date.parse("2026-09-14T17:00:00Z");
  const store = createMemoryClaimStore({ now: () => now });
  const [first, second] = await store.claimMany([
    { userID: 1, token: token(1), kind: "streak:reminder", localDate: DAY },
    { userID: 1, token: token(1), kind: "meal:dinner", localDate: DAY },
  ]);
  await store.complete([{ claim: first, status: "sent" }, { claim: second, status: "failed", error: "boom" }]);
  now += 45 * 60_000;
  assert.deepEqual(await store.recentHistory([1, 2], LIMIT_HISTORY_DAYS), [{ userID: 1, kind: "streak:reminder", localDate: DAY, ageMinutes: 45 }]);

  const db = createFakeDb({ default: () => [{ userID: 1, kind: "streak:reminder", localDate: DAY, ageMinutes: 45 }] });
  const rows = await createDbClaimStore(db).recentHistory([1, 1, 2], 3);
  assert.equal(rows.length, 1);
  assert.match(db.calls[0].sql, /status <> 'failed'/);
  assert.deepEqual(db.calls[0].params, [[1, 2], 3]);
});
