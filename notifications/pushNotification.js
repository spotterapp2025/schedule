// pushNotification.js
import { Expo } from "expo-server-sdk";
import log from "minhluanlu-color-log";


const expo = new Expo();

/**
 * Get a single Expo token for a user.
 * @param {number|string} userID
 * @returns {Promise<string|null>}
 */
async function getToken(userID) {
  try {
    // Use parameterized SQL (adjust placeholders to your DB driver)
    const rows = await RunQuery(
      `SELECT expoToken FROM socketio WHERE userID = ${userID}`
    );
    return rows?.[0]?.expoToken ?? null;
  } catch (err) {
    log.err("getToken error:", err);
    return null;
  }
}

/**
 * Send ONE Expo push notification to ONE user.
 * @param {{userID: number|string}} user
 * @param {{title: string, body: string, data?: object}} payload
 * @returns {Promise<{success: boolean, ticket?: any, message?: string, error?: string}>}
 */
export async function PushOneNotification(user, payload) {
  try {
    const userID = user?.userID;
    // 1) Get token
    const token = user?.expoToken;
    log.warn(token)
    if (!token) {
      log.warn(`No Expo token found for userID: ${userID}`);
      return { success: false, message: "No token found" };
    }

    // 2) Validate
    if (!Expo.isExpoPushToken(token)) {
      log.err(`Invalid Expo token: ${token}`);
      return { success: false, message: "Invalid token" };
    }

    // 3) Build message
    const message = {
      to: token,
      sound: "default",
      title: payload?.title ?? "New Message",
      body: payload?.body ?? "You have a new message!",
      data: payload?.data ?? {},
      priority: "high",
    };

    // 4) Send (array API even for one message)
    const tickets = await expo.sendPushNotificationsAsync([message]);
    const ticket = tickets?.[0];

    log.info(`Notification sent to user ${userID}: ${JSON.stringify(ticket)}`);
    return { success: true, ticket };
  } catch (error) {
    log.err("pushNotification error:", error);
    return { success: false, error: error.message };
  }
}


