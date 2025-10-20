import {RunQuery} from "../db/connection.js";
import log from "minhluanlu-color-log";
import {PushOneNotification} from "../notifications/pushNotification.js"


async function GetUsersForMacro() {
    try{
        const users = await RunQuery(`
            SELECT * 
            FROM users 
            INNER JOIN socketio 
                ON users.userID = socketio.userID
            WHERE socketio.expoToken IS NOT NULL
        `);
        if(users.length === 0) return null;
        return users;
    }
    catch(err){
        console.log(err);
        return null;
    }
};


async function GetUserForStepProgress() {
    try{
        const result = await RunQuery(`
        SELECT 
            stepTracker.id,
            stepTracker.userID,
            stepTracker.steps,
            stepTracker.date,
            workoutPlan.workoutGoal,
            workoutPlan.stepGoal,
            workoutPlan.workoutType,
            workoutPlan.preferredTime,
            workoutPlan.frequency
        FROM stepTracker
        LEFT JOIN workoutPlan
            ON stepTracker.userID = workoutPlan.userID
        WHERE stepTracker.date = CURDATE()
        `);
        if(result.length === 0) return null;
        return result;
    }
    catch(err){
        console.log(err);
        return null;
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function MakeMacroReminder(title, body, data) {
    try{
        const users = await GetUsersForMacro();
        if(!users) return null;

        for(const user of users){
            const payload = {
                title: title ?? "New Reminder",
                body: body ?? "You have a new reminder!",
                data: data ?? {},
                priority: "high",
            };
            await PushOneNotification(user, payload);
            await delay(1000);
        };
        return true;
    }
    catch(err){
        return null;
    }
}

async function MakeStepProgressReminder() {
  try {
    const users = await GetUserForStepProgress();
    if (!users || users.length === 0) return;

    for (const user of users) {
      const stepGoal = user?.stepGoal ? Number(user.stepGoal) : null;
      const steps = user?.steps ?? 0;

      let payload;

      // Case 1: user has no step goal set
      if (!stepGoal) {
        payload = {
          title: "🏃 Step Goal Reminder",
          body: "You haven’t set a daily step goal yet. Set one to start tracking your progress!",
          data: { type: "achievement-step" }
        };
      }
      // Case 2: user has a goal but no steps yet
      else if (steps === 0) {
        payload = {
          title: "🏃 Step Goal Reminder",
          body: "You’ve got 0 steps so far — let’s take a short walk to get started! 🚶‍♂️",
          data: { type: "achievement-step" }
        };
      }
      // Case 3: user is progressing
      else {
        const remaining = Math.max(stepGoal - steps, 0);
        payload = {
          title: "🏃 Step Goal Progress",
          body:
            remaining > 0
              ? `You’re doing great! Only ${remaining.toLocaleString()} steps left to reach your goal today 🎯`
              : `Amazing! You’ve hit your step goal for today! 🏅`,
          data: { type: "achievement-step" }
        };
      }

      // Send notification
      await PushOneNotification(user, payload);
    }
  } catch (err) {
    console.error("Error in MakeStepProgressReminder:", err);
    return null;
  }
}



export {
    MakeMacroReminder,
    MakeStepProgressReminder
}