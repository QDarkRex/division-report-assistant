import makeWASocket, { Browsers, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";

/**
 * One-shot, read-only discovery CLI — NOT part of the running app. Lists
 * one group's participants (JID + WhatsApp group-admin flag only, no
 * message content) so the operator can match JIDs to real names before
 * seeding the members table. Never wipes the auth folder, never sends a
 * message.
 *
 * Usage: node dist/whatsapp/list-participants.js <groupJid> [authFolder]
 */
async function main() {
  const groupJid = process.argv[2];
  const authFolder = process.argv[3] ?? "/opt/app/data/division-report-assistant/baileys-session";

  if (!groupJid) {
    console.error("Usage: node list-participants.js <groupJid> [authFolder]");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, browser: Browsers.ubuntu("Chrome"), printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") resolve();
      if (update.connection === "close") reject(new Error("connection closed before reaching group metadata"));
    });
  });

  const metadata = await sock.groupMetadata(groupJid);
  console.log(`GROUP: ${metadata.subject}`);
  console.log(`PARTICIPANT_COUNT: ${metadata.participants.length}`);
  for (const p of metadata.participants) {
    console.log(`PARTICIPANT: ${p.id}\tadmin=${p.admin ?? "member"}`);
  }

  await sock.end(undefined);
  process.exit(0);
}

main().catch((error) => {
  console.error("LIST_PARTICIPANTS_ERROR:", error);
  process.exit(1);
});
