import makeWASocket, { Browsers, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";

/**
 * One-shot, read-only discovery CLI — NOT part of the running app. Lists
 * the paired account's groups (name + JID only) so the operator can pick
 * the correct WHATSAPP_GROUP_JID for config/env.ts without guessing.
 * Never wipes the auth folder, never sends a message.
 *
 * Usage: node dist/whatsapp/list-groups.js [authFolder]
 */
async function main() {
  const authFolder = process.argv[2] ?? "/opt/app/data/division-report-assistant/baileys-session";

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, browser: Browsers.ubuntu("Chrome"), printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") resolve();
      if (update.connection === "close") reject(new Error("connection closed before reaching groups"));
    });
  });

  const groups = await sock.groupFetchAllParticipating();
  console.log(`GROUP_COUNT: ${Object.keys(groups).length}`);
  for (const group of Object.values(groups)) {
    console.log(`GROUP: ${group.id}\tparticipants=${group.participants.length}\tname=${group.subject}`);
  }

  await sock.end(undefined);
  process.exit(0);
}

main().catch((error) => {
  console.error("LIST_GROUPS_ERROR:", error);
  process.exit(1);
});
