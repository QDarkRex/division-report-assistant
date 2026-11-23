import { BaileysConnector } from "./baileys-connector.ts";

/**
 * One-shot, read-only verification CLI — NOT part of the running app.
 * Connects the real BaileysConnector (not pair.ts) against an ALREADY
 * PAIRED auth-state folder to confirm the class this app actually uses
 * can reach connection.update "open" against the live session. Never
 * wipes the auth folder (that would deauth a working session) and never
 * sends a message — observation only.
 *
 * Usage: node dist/whatsapp/verify-live.js [authFolder] [waitMs]
 */
async function main() {
  const authFolder = process.argv[2] ?? "/opt/app/data/division-report-assistant/baileys-session";
  const waitMs = Number(process.argv[3] ?? 20000);

  const connector = new BaileysConnector({ authStateFolder: authFolder, allowedGroupJid: process.env.WHATSAPP_GROUP_JID ?? "" });

  connector.onConnectionUpdate((status) => {
    console.log("STATUS_UPDATE:", JSON.stringify(status));
  });
  connector.onMessage((message) => {
    console.log("OBSERVED_MESSAGE (not processed):", message.messageId, message.chatJid);
  });

  console.log(`VERIFY_START authFolder=${authFolder} waitMs=${waitMs}`);
  await connector.connect();

  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const finalStatus = connector.getConnectionStatus();
  console.log("FINAL_STATUS:", JSON.stringify(finalStatus));
  await connector.disconnect();
  console.log(finalStatus.connected ? "VERIFY_RESULT: CONNECTED" : "VERIFY_RESULT: NOT_CONNECTED");
  process.exit(finalStatus.connected ? 0 : 1);
}

main().catch((error) => {
  console.error("VERIFY_ERROR:", error);
  process.exit(1);
});
