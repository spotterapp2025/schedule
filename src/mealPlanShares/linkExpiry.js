// Share Meal Plan: tells the owner when a meal plan QR code expires or reaches its usage limit (api migration
// 0014_meal_plan_sharing). The API already refuses such codes the moment they stop working; this is only the notice.
// Each link is announced once: expiryNotifiedAt claims it, so restarts or several workers never send it twice.
// Only plans that are still shared are announced (stopping sharing or turning a code off already told the owner's intent).

export const LINK_EXPIRED_TYPE = "meal-plan-link-expired";

const quoted = (title) => `“${String(title ?? "meal plan").trim() || "meal plan"}”`;

/** In-app notification and push for one link. `reason`: "expired" or "used_up". */
export function linkExpiredContent({ linkID, shareID, title, reason, maxUses }) {
  const usedUp = reason === "used_up";
  const name = usedUp ? "QR code limit reached" : "QR code expired";
  const message = usedUp
    ? `Your QR code for ${quoted(title)} reached its limit of ${maxUses} ${Number(maxUses) === 1 ? "use" : "uses"}. Create a new one to keep sharing.`
    : `Your QR code for ${quoted(title)} has expired. Create a new one to keep sharing.`;
  const data = { type: LINK_EXPIRED_TYPE, shareID: Number(shareID), linkID: Number(linkID), reason };
  return { type: LINK_EXPIRED_TYPE, name, message, data, push: { title: usedUp ? "Meal plan QR code limit reached" : "Meal plan QR code expired", body: message, data } };
}

/**
 * @param {{db: {query: Function}, sender: {send: Function}, logger: any, capabilities: {current: () => any},
 *          now?: () => Date, dryRun?: boolean, batchSize?: number}} deps
 */
export function createLinkExpiryJob({ db, sender, logger, capabilities, now = () => new Date(), dryRun = false, batchSize = 200 }) {
  async function run() {
    const summary = { due: 0, notified: 0, pushed: 0, skipped: 0 };
    if (!capabilities.current().mealPlanShares) return summary;

    const at = now();
    const rows = await db.query(
      `/* mealPlanLinks:due */ SELECT l.id, l.shareID, l.expiresAt, l.maxUses, l.useCount, s.ownerUserID, s.title, t.expoToken
       FROM mealPlanShareLinks l
       JOIN mealPlanShares s ON s.id = l.shareID AND s.status = 'active'
       LEFT JOIN socketio t ON t.userID = s.ownerUserID
       WHERE l.revokedAt IS NULL AND l.expiryNotifiedAt IS NULL
         AND ((l.expiresAt IS NOT NULL AND l.expiresAt <= ?) OR (l.maxUses IS NOT NULL AND l.useCount >= l.maxUses))
       ORDER BY l.id
       LIMIT ?`,
      [at, batchSize]
    );
    summary.due = rows.length;
    if (!rows.length || dryRun) {
      if (rows.length) logger.info("Meal plan QR codes due for an expiry notice (dry run)", { count: rows.length });
      return summary;
    }

    const pushes = [];
    for (const row of rows) {
      const claimed = await db.query(
        `/* mealPlanLinks:claim */ UPDATE mealPlanShareLinks SET expiryNotifiedAt = ? WHERE id = ? AND expiryNotifiedAt IS NULL`,
        [at, row.id]
      );
      if (claimed?.affectedRows !== 1) {
        summary.skipped++;
        continue;
      }
      const expired = row.expiresAt && new Date(row.expiresAt).getTime() <= at.getTime();
      const content = linkExpiredContent({ linkID: row.id, shareID: row.shareID, title: row.title, reason: expired ? "expired" : "used_up", maxUses: row.maxUses });
      try {
        await db.query(
          `/* mealPlanLinks:notify */ INSERT INTO notifications (userID, type, name, message, data) VALUES (?, ?, ?, ?, ?)`,
          [row.ownerUserID, content.type, content.name, content.message, JSON.stringify(content.data)]
        );
        summary.notified++;
      } catch (err) {
        logger.error("Could not save a meal plan QR code expiry notification", { linkID: row.id, error: err?.message });
      }
      if (row.expoToken) {
        pushes.push({ claimID: 0, userID: row.ownerUserID, token: row.expoToken, kind: LINK_EXPIRED_TYPE, localDate: "", message: content.push });
      }
    }

    if (pushes.length) {
      const results = await sender.send(pushes);
      summary.pushed = results.filter((result) => result.outcome === "sent").length;
    }
    if (summary.notified || summary.skipped) logger.info("Meal plan QR code expiry notices", summary);
    return summary;
  }

  return { run };
}
