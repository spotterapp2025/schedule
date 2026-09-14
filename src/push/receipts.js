// Expo only confirms delivery in receipts fetched ~15 minutes after sending. Receipts reveal uninstalled apps
// (DeviceNotRegistered), whose tokens are then removed so they stop being retried forever.

/**
 * @param {{expo: any, store: any, sender: {clearTokens: (tokens: string[]) => Promise<void>}, logger: any,
 *          olderThanMinutes?: number, limit?: number, giveUpAfterMinutes?: number}} deps
 */
export async function checkReceipts({ expo, store, sender, logger, olderThanMinutes = 15, limit = 1000, giveUpAfterMinutes = 24 * 60 }) {
  const pending = await store.pendingReceipts({ olderThanMinutes, limit });
  const summary = { checked: pending.length, delivered: 0, failed: 0, unknown: 0 };
  if (!pending.length) return summary;

  const byTicket = new Map(pending.map((row) => [row.ticketID, row]));
  const seen = new Set();
  const updates = [];
  const deadTokens = [];

  for (const ids of expo.chunkPushNotificationReceiptIds([...byTicket.keys()])) {
    let receipts;
    try {
      receipts = await expo.getPushNotificationReceiptsAsync(ids);
    } catch (err) {
      logger.warn("Could not fetch push receipts; will try again later", { error: err?.message });
      continue;
    }
    for (const [ticketID, receipt] of Object.entries(receipts ?? {})) {
      const row = byTicket.get(ticketID);
      if (!row) continue;
      seen.add(ticketID);
      if (receipt?.status === "ok") {
        updates.push({ id: row.id, status: "delivered", error: null });
        summary.delivered++;
      } else {
        const code = receipt?.details?.error ?? receipt?.message ?? "UnknownError";
        updates.push({ id: row.id, status: "failed", error: String(code).slice(0, 255) });
        summary.failed++;
        if (receipt?.details?.error === "DeviceNotRegistered") deadTokens.push(row.pushToken);
      }
    }
  }

  // Expo keeps receipts for about a day; stop asking after that.
  for (const row of pending) {
    if (!seen.has(row.ticketID) && Number(row.ageMinutes) >= giveUpAfterMinutes) {
      updates.push({ id: row.id, status: "unknown", error: "ReceiptUnavailable" });
      summary.unknown++;
    }
  }

  if (updates.length) await store.markReceipts(updates);
  await sender.clearTokens(deadTokens);
  return summary;
}
