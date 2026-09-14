// Sends reminders through Expo in batches (100 per request) and removes tokens of uninstalled apps.
import { Expo } from "expo-server-sdk";

// Expo rejects messages over 4096 bytes; keep headroom (same limit as the API).
export const MAX_PUSH_BYTES = 3800;

/** @param {string} token @param {{title: string, body: string, data?: object}} content */
export function buildPushMessage(token, { title, body, data }) {
  const message = { to: token, sound: "default", title, body, data: data ?? {}, priority: "high", channelId: "default" };
  if (Buffer.byteLength(JSON.stringify(message)) > MAX_PUSH_BYTES) {
    // Keep only the type so a tap still opens the right screen.
    message.data = { type: message.data?.type };
  }
  return message;
}

/**
 * @typedef {{claimID: number, userID: number, token: string, kind: string, localDate: string, message: {title: string, body: string, data?: object}}} PushItem
 * @typedef {{item: PushItem, outcome: "sent" | "failed" | "retry", ticketID?: string | null, error?: string}} PushResult
 */

export function createPushSender({ expo, db, logger, dryRun = false, isValidToken = (token) => Expo.isExpoPushToken(token) }) {
  async function clearTokens(tokens) {
    const unique = [...new Set(tokens.filter(Boolean))];
    if (!unique.length || dryRun) return;
    try {
      await db.query("UPDATE socketio SET expoToken = NULL WHERE expoToken IN (?)", [unique]);
      logger.warn("Removed push tokens that are invalid or no longer registered", { count: unique.length });
    } catch (err) {
      logger.error("Could not remove dead push tokens", { error: err?.message });
    }
  }

  /** @param {PushItem[]} items @returns {Promise<PushResult[]>} */
  async function send(items) {
    /** @type {PushResult[]} */
    const results = [];
    const deadTokens = [];
    const valid = [];
    for (const item of items) {
      if (isValidToken(item.token)) valid.push(item);
      else {
        results.push({ item, outcome: "failed", error: "InvalidPushToken" });
        deadTokens.push(item.token);
      }
    }

    if (dryRun) {
      for (const item of valid) results.push({ item, outcome: "sent", ticketID: null });
      return results;
    }

    const chunks = expo.chunkPushNotifications(valid.map((item) => buildPushMessage(item.token, item.message)));
    let offset = 0;
    for (const chunk of chunks) {
      const chunkItems = valid.slice(offset, offset + chunk.length);
      offset += chunk.length;
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        chunkItems.forEach((item, index) => {
          const ticket = tickets?.[index];
          if (ticket?.status === "ok") {
            results.push({ item, outcome: "sent", ticketID: ticket.id });
            return;
          }
          const code = ticket?.details?.error ?? ticket?.message ?? "UnknownError";
          if (code === "DeviceNotRegistered") deadTokens.push(item.token);
          results.push({ item, outcome: code === "MessageRateExceeded" ? "retry" : "failed", error: String(code) });
        });
      } catch (err) {
        // Network/Expo outage: release the claims so the next tick (within the grace window) retries.
        logger.error("Expo push request failed; will retry on the next tick", { count: chunkItems.length, error: err?.message });
        for (const item of chunkItems) results.push({ item, outcome: "retry", error: err?.message });
      }
    }

    await clearTokens(deadTokens);
    return results;
  }

  return { send, clearTokens };
}
