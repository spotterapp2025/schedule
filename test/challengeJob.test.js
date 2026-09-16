// Challenges: started, milestone and completed notices and final results. Fake database and sender; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createChallengeJob, challengeNoticeContent } from "../src/challenges/challengeJob.js";
import { createFakeDb, placeholderCount, silentLogger, staticCapabilities, token } from "./helpers.js";

const DAYTIME = new Date("2026-09-16T10:00:00Z"); // 12:00 in Oslo
const NIGHT = new Date("2026-09-16T21:30:00Z"); // 23:30 in Oslo
const challenge = (overrides = {}) => ({
  id: 7, creatorUserID: 1, name: "Step it up", category: "steps", target: 3, startDate: "2026-09-10", endDate: "2026-09-20",
  timezone: "Europe/Oslo", status: "scheduled", startNotifiedAt: null, finalizedAt: null, ...overrides,
});
const member = (userID, overrides = {}) => ({ id: 100 + userID, userID, role: userID === 1 ? "creator" : "participant", milestoneNotified: 0, firstName: `User${userID}`, lastName: "", expoToken: token(userID), ...overrides });

function setup({ challenges = [challenge()], members = [member(1), member(2)], steps = [], claim = 1, caps = { challenges: true }, dryRun = false, at = DAYTIME } = {}) {
  const sent = [];
  const db = createFakeDb({
    "challenges:due": () => challenges,
    "challenges:members": () => members,
    "challenges:users": () => members.map((m) => ({ userID: m.userID, timezone: "Europe/Oslo" })),
    "challenges:history": () => [],
    "challenges:current": () => members.map((m) => ({ userID: m.userID, goal: 10000 })),
    "challenges:data": () => steps,
    "challenges:claimStart": () => ({ affectedRows: claim }),
    "challenges:claimMilestone": () => ({ affectedRows: claim }),
    "challenges:claimFinal": () => ({ affectedRows: claim }),
    "challenges:saveResult": () => ({ affectedRows: 1 }),
    "challenges:notify": () => ({ affectedRows: 1 }),
  });
  const sender = { send: async (items) => { sent.push(...items); return items.map((item) => ({ item, outcome: "sent" })); } };
  const job = createChallengeJob({ db, sender, logger: silentLogger, capabilities: staticCapabilities(caps), now: () => at, dryRun, defaultTimeZone: "Europe/Oslo" });
  return { db, sent, job };
}
const calls = (db, tag) => db.calls.filter((call) => call.sql.includes(tag));
const walked = (userID, days) => days.map((day) => ({ userID, day, steps: 12000 }));

test("the start notice goes out once, in the daytime, to everyone who joined", async () => {
  const { db, sent, job } = setup();
  const summary = await job.run();
  assert.equal(summary.started, 2);
  assert.equal(calls(db, "challenges:claimStart").length, 1);
  assert.deepEqual(sent.map((item) => item.token).sort(), [token(1), token(2)]);
  assert.match(sent[0].message.body, /Reach 3 days in a row to win/);

  const again = setup({ claim: 0 });
  assert.equal((await again.job.run()).started, 0, "another worker already sent it");
  const already = setup({ challenges: [challenge({ startNotifiedAt: new Date() })] });
  assert.equal((await already.job.run()).started, 0);
  const night = setup({ at: NIGHT });
  assert.equal((await night.job.run()).started, 0, "never at night");
  assert.equal(night.db.calls.filter((call) => call.sql.includes("challenges:members")).length, 0);
});

test("milestones: 50% and 100% reach only that participant, each once", async () => {
  const { db, sent, job } = setup({
    challenges: [challenge({ startNotifiedAt: new Date() })],
    members: [member(1), member(2, { milestoneNotified: 50 })],
    steps: [...walked(1, ["2026-09-14", "2026-09-15"]), ...walked(2, ["2026-09-13", "2026-09-14", "2026-09-15"])],
  });
  const summary = await job.run();
  assert.equal(summary.milestones, 2);
  const claims = calls(db, "challenges:claimMilestone").map((call) => call.params);
  assert.deepEqual(claims, [[50, 101, 50], [100, 102, 100]]);
  assert.match(sent.find((item) => item.userID === 1).message.title, /Halfway/);
  assert.match(sent.find((item) => item.userID === 2).message.title, /Target reached/);
  for (const call of db.calls) assert.equal(placeholderCount(call.sql), call.params.length, call.sql.slice(0, 50));
});

test("after the last day, results are frozen once with winners and ties, and everyone hears how they did", async () => {
  const ended = challenge({ startDate: "2026-09-08", endDate: "2026-09-14", startNotifiedAt: new Date() });
  const { db, sent, job } = setup({
    challenges: [ended],
    members: [member(1), member(2), member(3)],
    steps: [...walked(1, ["2026-09-08", "2026-09-09", "2026-09-10"]), ...walked(2, ["2026-09-08", "2026-09-09", "2026-09-10"]), ...walked(3, ["2026-09-12"])],
  });
  const summary = await job.run();
  assert.deepEqual([summary.finalized, summary.completed], [1, 3]);
  const results = calls(db, "challenges:saveResult").map((call) => call.params.slice(0, 2));
  assert.deepEqual(results, [[1, 1], [1, 1], [3, 0]], "users 1 and 2 share first place");
  assert.match(sent.find((item) => item.userID === 1).message.title, /shared first place/);
  assert.match(sent.find((item) => item.userID === 3).message.body, /You finished #3\. Winners: User1 & User2/);

  const raced = setup({ challenges: [ended], claim: 0 });
  assert.equal((await raced.job.run()).finalized, 0, "finalized elsewhere: nothing written");
  assert.equal(calls(raced.db, "challenges:saveResult").length, 0);
});

test("nothing happens before the migration, and a dry run writes nothing", async () => {
  const before = setup({ caps: { challenges: false } });
  assert.equal((await before.job.run()).checked, 0);
  assert.equal(before.db.calls.length, 0);

  const dry = setup({ dryRun: true });
  await dry.job.run();
  assert.equal(dry.db.calls.filter((call) => !/challenges:(due|members)/.test(call.sql)).length, 0);
  assert.equal(dry.sent.length, 0);
});

test("a one-person challenge has no winner or loser", () => {
  const content = challengeNoticeContent({
    kind: "completed",
    challenge: challenge(),
    member: { userID: 1 },
    entry: { rank: 1, progress: { best: 2 } },
    ranked: [{ userID: 1, name: "Solo", rank: 1, progress: { best: 2 } }],
  });
  assert.equal(content.data.outcome, "none");
  assert.match(content.message, /You made it to 2 in a row/);
});

test("the worker uses the same challenge rules as the API", () => {
  const worker = readFileSync(new URL("../src/challenges/challengeRules.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../../api/challenges/challengeRules.js", import.meta.url), "utf8");
  assert.equal(worker, api);
});

test("nutrition challenges count calories imported from Apple Health / Health Connect, once the table exists", async () => {
  const { loadProgressData } = await import("../src/challenges/challengeData.js");
  const macro = challenge({ category: "macro", startDate: "2026-09-14", endDate: "2026-09-16" });
  const db = createFakeDb({
    "challenges:users": () => [{ userID: 1, timezone: "UTC" }],
    "challenges:current": () => [{ userID: 1, goal: 2000 }],
    // 1,000 kcal of logged meals on the 14th (12:00 UTC).
    "challenges:data": () => [{ userID: 1, bucket: Date.parse("2026-09-14T12:00:00Z") / 1000, kcal: 1000 }],
    "challenges:imported": () => [
      { userID: 1, day: "2026-09-14", kcal: 800 },
      { userID: 1, day: "2026-09-15", kcal: 1900 },
    ],
  });

  const without = await loadProgressData(db, macro, [1], "UTC");
  assert.deepEqual(without.get("1").data.values, { "2026-09-14": 1000 });
  assert.equal(calls(db, "challenges:imported").length, 0, "no query before api migration 0017");

  const withImported = await loadProgressData(db, macro, [1], "UTC", { importedKcal: true });
  assert.deepEqual(withImported.get("1").data.values, { "2026-09-14": 1000, "2026-09-15": 1900 }, "the higher of meals and imported, never added");
  const [call] = calls(db, "challenges:imported");
  assert.equal(placeholderCount(call.sql), call.params.length);
});
