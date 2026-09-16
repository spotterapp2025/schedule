// Challenges (the Racing feature): the notices that depend on time or progress, plus final results.
// - started: once, when a challenge begins, to everyone who joined.
// - milestone: to one participant when their progress reaches 50% and 100% of the target — each at most once.
// - completed: after the last day, results are frozen (rank, winner, progress) and everyone gets their result.
// Only between 08:00 and 21:00 in the challenge's time zone, so nobody is woken up. Every notice is claimed with a
// conditional update first, so restarts or several workers never send one twice. Invitations and answers are sent by
// the API when they happen.
import {
  CHALLENGE_NOTIFICATION_TYPES as TYPES,
  challengeStatus,
  localDateInZone,
  localHourInZone,
  milestoneToNotify,
  outcomeFor,
  participantProgress,
  rankParticipants,
  unitsLabel,
  winnersOf,
} from "./challengeRules.js";
import { loadProgressData } from "./challengeData.js";

export const CHALLENGE_DAYTIME = Object.freeze({ fromHour: 8, untilHour: 21 });

const blank = (value) => value === null || value === undefined || ["", "null", "undefined"].includes(String(value).trim());
const nameOf = (row) => [row?.firstName, row?.lastName].filter((part) => !blank(part)).map((part) => String(part).trim()).join(" ") || "Someone";
const quoted = (challenge) => `“${challenge.name}”`;

/** The copy for started, milestone and completed notices. Pure. */
export function challengeNoticeContent({ kind, challenge, member, entry, ranked }) {
  const data = { type: TYPES[kind], challengeID: Number(challenge.id) };
  let title;
  let body;
  if (kind === "started") {
    title = "🏁 Your challenge has started";
    body = `${quoted(challenge)} is on! Reach ${unitsLabel(challenge.category, challenge.target)} in a row to win.`;
  } else if (kind === "milestone") {
    const milestone = entry.milestone;
    data.milestone = milestone;
    title = milestone >= 100 ? "🎯 Target reached!" : "🔥 Halfway there";
    body =
      milestone >= 100
        ? `You reached ${unitsLabel(challenge.category, challenge.target)} in a row in ${quoted(challenge)}. Keep it going to stay on top!`
        : `You're halfway to the target in ${quoted(challenge)} — ${entry.progress.best} of ${unitsLabel(challenge.category, challenge.target)} in a row.`;
  } else {
    const outcome = outcomeFor(member.userID, ranked);
    const winners = winnersOf(ranked);
    data.outcome = outcome;
    if (outcome === "won") {
      title = winners.length > 1 ? `🏆 You shared first place in ${quoted(challenge)}!` : `🏆 You won ${quoted(challenge)}!`;
      body = `Amazing work — ${entry.progress.best} ${challenge.category === "workouts" ? "weeks" : "days"} in a row. Open it to celebrate.`;
    } else if (outcome === "lost") {
      const names = winners.map((winner) => winner.name).join(" & ");
      title = `🎉 ${quoted(challenge)} is over`;
      body = `You finished #${entry.rank}. ${winners.length > 1 ? "Winners" : "Winner"}: ${names}. Great effort — ready for a rematch?`;
    } else {
      title = `🎉 ${quoted(challenge)} is over`;
      body = entry?.progress?.best ? `You made it to ${entry.progress.best} in a row. See how everyone did.` : "See how everyone did — and start a new one anytime.";
    }
    return { name: title.replace(/^\S+\s/, ""), message: body, data, push: { title, body, data } };
  }
  return { name: title.replace(/^\S+\s/, ""), message: body, data, push: { title, body, data } };
}

/**
 * @param {{db: {query: Function}, sender: {send: Function}, logger: any, capabilities: {current: () => any}, now?: () => Date,
 *          dryRun?: boolean, defaultTimeZone?: string, batchSize?: number}} deps
 */
export function createChallengeJob({ db, sender, logger, capabilities, now = () => new Date(), dryRun = false, defaultTimeZone = "UTC", batchSize = 200 }) {
  async function notify(members, contentFor, summary, key) {
    const pushes = [];
    for (const member of members) {
      const content = contentFor(member);
      if (!content) continue;
      await db.query(
        `/* challenges:notify */ INSERT INTO notifications (userID, type, name, message, data) VALUES (?, ?, ?, ?, ?)`,
        [member.userID, content.data.type, content.name, content.message, JSON.stringify(content.data)]
      );
      summary[key]++;
      if (member.expoToken) pushes.push({ claimID: 0, userID: member.userID, token: member.expoToken, kind: content.data.type, localDate: "", message: content.push });
    }
    if (pushes.length) {
      const results = await sender.send(pushes);
      summary.pushed += results.filter((result) => result.outcome === "sent").length;
    }
  }

  async function run() {
    const summary = { checked: 0, started: 0, milestones: 0, finalized: 0, completed: 0, pushed: 0 };
    if (!capabilities.current().challenges) return summary;

    const at = now();
    const utcToday = at.toISOString().slice(0, 10);
    const challenges = await db.query(
      `/* challenges:due */ SELECT id, creatorUserID, name, category, target, DATE_FORMAT(startDate, '%Y-%m-%d') AS startDate,
         DATE_FORMAT(endDate, '%Y-%m-%d') AS endDate, timezone, status, startNotifiedAt, finalizedAt
       FROM challenges
       WHERE status = 'scheduled' AND finalizedAt IS NULL AND startDate <= ? + INTERVAL 1 DAY
       ORDER BY endDate, id
       LIMIT ?`,
      [utcToday, batchSize]
    );

    for (const challenge of challenges) {
      summary.checked++;
      const zone = challenge.timezone || defaultTimeZone;
      const today = localDateInZone(at, zone);
      const hour = localHourInZone(at, zone);
      const status = challengeStatus(challenge, today);
      if (status === "upcoming" || hour < CHALLENGE_DAYTIME.fromHour || hour >= CHALLENGE_DAYTIME.untilHour) continue;

      const members = await db.query(
        `/* challenges:members */ SELECT p.id, p.userID, p.role, p.milestoneNotified, u.firstName, u.lastName, t.expoToken
         FROM challengeParticipants p JOIN users u ON u.userID = p.userID LEFT JOIN socketio t ON t.userID = p.userID
         WHERE p.challengeID = ? AND p.status = 'accepted'`,
        [challenge.id]
      );
      if (!members.length) continue;

      if (dryRun) {
        logger.info("Challenge due (dry run)", { challengeID: challenge.id, status });
        continue;
      }

      const data = await loadProgressData(db, challenge, members.map((member) => member.userID), defaultTimeZone, { importedKcal: !!capabilities.current().healthDays });
      const ranked = rankParticipants(
        members.map((member) => {
          const loaded = data.get(String(member.userID));
          const memberToday = loaded ? localDateInZone(at, loaded.zone) : today;
          return { userID: Number(member.userID), name: nameOf(member), progress: participantProgress(challenge, loaded?.data ?? {}, memberToday) };
        })
      );
      const entryFor = (member) => ranked.find((entry) => entry.userID === Number(member.userID));

      if (status === "active") {
        if (!challenge.startNotifiedAt) {
          const claimed = await db.query(`/* challenges:claimStart */ UPDATE challenges SET startNotifiedAt = ? WHERE id = ? AND startNotifiedAt IS NULL`, [at, challenge.id]);
          if (claimed?.affectedRows === 1) await notify(members, () => challengeNoticeContent({ kind: "started", challenge }), summary, "started");
        }
        for (const member of members) {
          const entry = entryFor(member);
          const milestone = entry ? milestoneToNotify(member.milestoneNotified, entry.progress.percent) : null;
          if (!milestone) continue;
          const claimed = await db.query(
            `/* challenges:claimMilestone */ UPDATE challengeParticipants SET milestoneNotified = ? WHERE id = ? AND milestoneNotified < ?`,
            [milestone, member.id, milestone]
          );
          if (claimed?.affectedRows === 1) {
            await notify([member], () => challengeNoticeContent({ kind: "milestone", challenge, member, entry: { ...entry, milestone } }), summary, "milestones");
          }
        }
        continue;
      }

      // completed: freeze the results once, then tell everyone.
      const claimed = await db.query(`/* challenges:claimFinal */ UPDATE challenges SET finalizedAt = ? WHERE id = ? AND finalizedAt IS NULL`, [at, challenge.id]);
      if (claimed?.affectedRows !== 1) continue;
      summary.finalized++;
      const winners = new Set(winnersOf(ranked).map((entry) => entry.userID));
      for (const member of members) {
        const entry = entryFor(member);
        await db.query(
          `/* challenges:saveResult */ UPDATE challengeParticipants SET finalRank = ?, isWinner = ?, finalResult = ? WHERE id = ?`,
          [entry?.rank ?? null, winners.has(Number(member.userID)) ? 1 : 0, JSON.stringify(entry?.progress ?? null), member.id]
        );
      }
      await notify(members, (member) => challengeNoticeContent({ kind: "completed", challenge, member, entry: entryFor(member), ranked }), summary, "completed");
    }

    if (summary.started || summary.milestones || summary.finalized) logger.info("Challenge notices", summary);
    return summary;
  }

  return { run };
}
