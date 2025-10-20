import { CronJob } from 'cron';
import log from 'minhluanlu-color-log';
import {MakeMacroReminder, MakeStepProgressReminder} from "./todo.js"


const scheduleTime = {
    Morning: "00 7 * * *",
    Lunch: "50 11 * * *",
    Dinner: '15 18 * * *'
}

// Example: Run at 6:45 AM every day
const Morning = new CronJob('54 12 * * *', async () => {
  console.log('⏰ Time for breakfast soon!');
  await MakeMacroReminder(
    "☀️ Morning Check-in",
    "Good morning! Have you had breakfast yet?",
    {
        type: "achievement-macro"
    }
  );
});

const Lunch = new CronJob('54 12 * * *', async () => {
  console.log('⏰ Time for breakfast soon!');
  await MakeMacroReminder(
    "🍱 Lunchtime Reminder",
    "It's lunch o'clock! Don’t forget to grab something tasty 🍛",
    {
        type: "achievement-macro"
    }
    );
});

const Dinner = new CronJob('54 12 * * *', async () => {
  console.log('⏰ Time for breakfast soon!');
  await MakeMacroReminder(
    "🍽️ Dinner Time",
    "Evening’s here — time for dinner and to relax a bit 🌙",
    {
        type: "achievement-macro"
    }
    );
});

// ========================================================== //
const MorningStepReminder = new CronJob('30 10 * * *', async () => {
  await MakeStepProgressReminder();
});

// Afternoon reminder (2:30 PM)
const AfternoonStepReminder = new CronJob('30 14 * * *', async () => {
  await MakeStepProgressReminder();
});

// Evening reminder (7:30 PM)
const EveningStepReminder = new CronJob('30 19 * * *', async () => {
  await MakeStepProgressReminder();
});


// Start the job
export default async function Schedule(){
    console.log(scheduleTime);
    log.info("Schedule is running");
    // Running //
    Morning.start();
    Lunch.start();
    Dinner.start();

    // ============== //
    MorningStepReminder.start();
    AfternoonStepReminder.start();
    EveningStepReminder.start();
}
