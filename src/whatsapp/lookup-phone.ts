import makeWASocket, { Browsers, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";

/**
 * One-shot, read-only lookup CLI — NOT part of the running app. Takes
 * phone numbers (international format, no +) and resolves each to its
 * `@lid` JID via Baileys' onWhatsApp(), so a known phone number can be
 * matched against the opaque @lid values already seen in group metadata
 * (list-participants.ts) and incoming_messages.sender_jid. Never wipes
 * the auth folder, never sends a message.
 *
 * Usage: node dist/whatsapp/lookup-phone.js <authFolder> <phone1> [phone2] [...]
 */
async function main() {
  const authFolder = process.argv[2];
  const phoneNumbers = process.argv.slice(3);

  if (!authFolder || phoneNumbers.length === 0) {
    console.error("Usage: node lookup-phone.js <authFolder> <phone1> [phone2] [...]");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, browser: Browsers.ubuntu("Chrome"), printQRInTerminal: false });
  sock.ev.on("creds.update", saveCreds);

  await new Promise<void>((resolve, reject) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") resolve();
      if (update.connection === "close") reject(new Error("connection closed before lookup"));
    });
  });

  const results = await sock.onWhatsApp(...phoneNumbers);
  console.log(`LOOKUP_COUNT: ${results?.length ?? 0}`);
  for (const r of results ?? []) {
    console.log(`RESULT: input_jid=${r.jid}\tlid=${String(r.lid)}\texists=${String(r.exists)}`);
  }

  await sock.end(undefined);
  process.exit(0);
}

main().catch((error) => {
  console.error("LOOKUP_PHONE_ERROR:", error);
  process.exit(1);
});
