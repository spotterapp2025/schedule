import { test } from "node:test";
import assert from "node:assert/strict";
import { MEAL_SLOTS, STEP_SLOTS } from "../src/reminders/definitions.js";
import { calorieSummary, cleanText, mealReminder, partnerDigest, stepReminder, workoutReminder } from "../src/reminders/messages.js";

const [morning, afternoon] = STEP_SLOTS;

test("meal reminders keep the original copy and open the daily tracker", () => {
  const message = mealReminder(MEAL_SLOTS[0]);
  assert.equal(message.title, "☀️ Morning Check-in");
  assert.deepEqual(message.data, { type: "achievement-macro" });
});

test("step reminders cover no goal, no steps, progress and goal reached", () => {
  assert.equal(stepReminder(morning, { steps: 0, stepGoal: "null" }).kind, "steps:no-goal");
  assert.equal(stepReminder(afternoon, { steps: 0, stepGoal: null }), null, "the goal prompt is only sent at the first check-in");

  const zero = stepReminder(afternoon, { steps: 0, stepGoal: "8000" });
  assert.equal(zero.kind, "steps:afternoon");
  assert.match(zero.body, /0 steps so far/);

  assert.match(stepReminder(morning, { steps: "2500", stepGoal: 10000 }).body, /7,500 steps left/);

  const done = stepReminder(afternoon, { steps: 12000, stepGoal: "10000" });
  assert.equal(done.kind, "steps:goal", "same kind all day, so it's only sent once");
  assert.equal(done.data.type, "achievement-step");
});

test("workout reminders describe the session and open Discover", () => {
  assert.match(workoutReminder({ workoutType: "Strength", preferredTime: "morning" }).body, /Your morning strength workout is on today's plan/);
  assert.match(workoutReminder({ workoutType: "null", preferredTime: "null" }).body, /Your workout is on today's plan/);
  assert.match(workoutReminder({ workoutType: "HIIT Workout", preferredTime: "evening" }).body, /Your evening hiit workout is/);
  assert.deepEqual(workoutReminder({}).data, { type: "new-feature", navigation: "Home" });
});

test("calorie summary: nothing logged, no goal, under and over goal", () => {
  assert.match(calorieSummary({ target: 2000, eaten: 0, burned: 0 }).title, /Don't forget to log/);
  assert.match(calorieSummary({ target: null, eaten: 1200, burned: 150 }).body, /Set a calorie goal/);
  assert.match(calorieSummary({ target: "2000.00", eaten: 1500, burned: 300 }).body, /1,500 of 2,000 kcal and burned 300 kcal — 800 kcal left/);
  assert.match(calorieSummary({ target: 1800, eaten: 2400, burned: 100 }).body, /500 kcal over today's goal/);
});

test("partner digest counts requests and likes and is skipped when there's nothing new", () => {
  assert.equal(partnerDigest({ pendingRequests: 0, newLikes: 0 }), null);
  assert.match(partnerDigest({ pendingRequests: 1, newLikes: 0 }).body, /You have 1 connection request waiting/);
  assert.match(partnerDigest({ pendingRequests: 2, newLikes: 3 }).body, /2 connection requests and 3 new likes/);
  assert.equal(partnerDigest({ newLikes: 1 }).data.type, "notifications");
});

test("cleanText treats the stored 'null' text as empty", () => {
  assert.equal(cleanText("null"), "");
  assert.equal(cleanText(" Yoga "), "Yoga");
  assert.equal(cleanText(42), "");
});
