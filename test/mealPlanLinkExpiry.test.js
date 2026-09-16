// Share Meal Plan: "QR code expired" notices for owners. Fake database and sender; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinkExpiryJob, linkExpiredContent, LINK_EXPIRED_TYPE } from "../src/mealPlanShares/linkExpiry.js";
import { createFakeDb, placeholderCount, silentLogger, staticCapabilities, token } from "./helpers.js";

const NOW = new Date("2026-09-16T12:00:00Z");
const due = (overrides = {}) => ({
  id: 3, shareID: 5, expiresAt: new Date("2026-09-16T11:00:00Z"), maxUses: null, useCount: 0, ownerUserID: 1, title: "Lean bulk", expoToken: token(1), ...overrides,
});

function setup({ rows = [due()], claimed = 1, caps = { mealPlanShares: true }, dryRun = false } = {}) {
  const sent = [];
  const db = createFakeDb({
    "mealPlanLinks:due": () => rows,
    "mealPlanLinks:claim": () => ({ affectedRows: claimed }),
    "mealPlanLinks:notify": () => ({ affectedRows: 1 }),
  });
  const sender = { send: async (items) => { sent.push(...items); return items.map((item) => ({ item, outcome: "sent" })); } };
  const job = createLinkExpiryJob({ db, sender, logger: silentLogger, capabilities: staticCapabilities(caps), now: () => NOW, dryRun });
  return { db, sent, job };
}

test("expired and used-up codes get clear notices that open the shared plan", () => {
  const expired = linkExpiredContent({ linkID: 3, shareID: 5, title: "Lean bulk", reason: "expired" });
  assert.equal(expired.type, LINK_EXPIRED_TYPE);
  assert.equal(expired.name, "QR code expired");
  assert.equal(expired.message, "Your QR code for “Lean bulk” has expired. Create a new one to keep sharing.");
  assert.deepEqual(expired.data, { type: "meal-plan-link-expired", shareID: 5, linkID: 3, reason: "expired" });
  const usedUp = linkExpiredContent({ linkID: 3, shareID: 5, title: "Lean bulk", reason: "used_up", maxUses: 1 });
  assert.match(usedUp.message, /limit of 1 use\./);
});

test("each due code is claimed once, then saved as a notification and pushed", async () => {
  const { db, sent, job } = setup();
  const summary = await job.run();
  assert.deepEqual(summary, { due: 1, notified: 1, pushed: 1, skipped: 0 });
  const [claim] = db.calls.filter((call) => call.sql.includes("mealPlanLinks:claim"));
  assert.deepEqual(claim.params, [NOW, 3]);
  const [notify] = db.calls.filter((call) => call.sql.includes("mealPlanLinks:notify"));
  assert.equal(notify.params[0], 1, "the owner gets it");
  assert.equal(JSON.parse(notify.params[4]).reason, "expired");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, token(1));
  for (const call of db.calls) assert.equal(placeholderCount(call.sql), call.params.length, call.sql.slice(0, 40));
});

test("a code another worker already claimed is skipped; no token means no push", async () => {
  const claimedElsewhere = setup({ claimed: 0 });
  assert.deepEqual(await claimedElsewhere.job.run(), { due: 1, notified: 0, pushed: 0, skipped: 1 });
  assert.equal(claimedElsewhere.sent.length, 0);

  const noToken = setup({ rows: [due({ expoToken: null, expiresAt: null, maxUses: 5, useCount: 5 })] });
  const summary = await noToken.job.run();
  assert.deepEqual(summary, { due: 1, notified: 1, pushed: 0, skipped: 0 });
  const [notify] = noToken.db.calls.filter((call) => call.sql.includes("mealPlanLinks:notify"));
  assert.equal(JSON.parse(notify.params[4]).reason, "used_up");
});

test("does nothing before the API migration, and writes nothing in a dry run", async () => {
  const before = setup({ caps: { mealPlanShares: false } });
  assert.deepEqual(await before.job.run(), { due: 0, notified: 0, pushed: 0, skipped: 0 });
  assert.equal(before.db.calls.length, 0);

  const dry = setup({ dryRun: true });
  assert.equal((await dry.job.run()).due, 1);
  assert.equal(dry.db.calls.filter((call) => !call.sql.includes("mealPlanLinks:due")).length, 0);
  assert.equal(dry.sent.length, 0);
});
