import { rm } from "node:fs/promises";
import makeWASocket, { Browsers, fetchLatestBaileysVersion, useMultiFileAuthState } from "baileys";
import { pino } from "pino";

/**
 * One-shot pairing-code CLI, not part of the running app — invoked
 * directly via `node dist/whatsapp/pair.js <phone> [authFolder]` against
 * a container with the real session volume mounted, so the resulting
 * auth state lands directly in its persistent location (no manual file
 * transfer). Pairing code, not QR: this runs headless (no display to scan
 * a QR against, and QR expires in ~20s — impractical to relay through
 * SSH/chat in time). MASTER_SPEC.md §5.1: encrypted auth state, no auth
 * ever committed to Git.
 *
 * Root-caused 2026-08-07 with an Opus chief-architect review after ~100
 * failed reconnects across several runs, all with the same symptom (code
 * issued fine, every subsequent reconnect died in 1-5s with "Connection
 * Failure", never once reaching "open"): this was NOT rate limiting. Two
 * real bugs:
 *  1. `useMultiFileAuthState(authFolder)` was re-read on every attempt
 *     WITHOUT ever wiping the folder. A pairing attempt the server
 *     rejects leaves partially-written creds on disk; every reconnect
 *     (and every subsequent script run) kept replaying that poisoned
 *     state, which the server keeps rejecting — deterministically, not
 *     probabilistically. Fixed: the folder is wiped at the start of
 *     every run (see main()).
 *  2. `makeWASocket()` was called with no `version` or `browser` —
 *     Baileys' pairing-code path is known to need a pinned WA protocol
 *     version and an explicit browser fingerprint; omitting them is a
 *     plausible contributor to the server-side 401s. Fixed below.
 *
 * The post-code-issuance close (before a human could possibly have acted)
 * is still real and still reports via `DisconnectReason.loggedOut` (401)
 * — indistinguishable by status code alone from an actual logout. Given
 * bug #1 is now fixed, a 401 that recurs across FRESH (wiped-folder) runs
 * would be a genuine signal worth escalating again (IP reputation,
 * account-side restriction) rather than assumed away.
 *
 * A THIRD issue surfaced once #1/#2 were fixed and the connection stopped
 * dying immediately: it stayed open through registration but then failed
 * with `Error: Invalid buffer` in Baileys' own notification parser
 * (Socket/messages-recv.js) while processing the pairing-completion
 * notification — a real bug in `baileys@7.0.0-rc14` (no stable 7.x exists
 * yet; rc14 is the 14th release candidate). Fixed by downgrading to
 * `baileys@6.7.24`, the latest version in the 6.7.x line the package's
 * own deprecation notice recommends (6.17.16, tried first, carries a
 * message-spoofing security advisory — do not use it). Pairing succeeded
 * on the very next attempt with 6.7.24. If a future Baileys upgrade is
 * considered, re-verify pairing end to end before trusting it, don't
 * assume a newer version number is safe by default.
 */
async function connectAndWait(phoneNumber: string, authFolder: string, requestCode: boolean): Promise<{ outcome: "paired" | "retry"; codeIssued: boolean }> {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: "info" }),
  });
  sock.ev.on("creds.update", saveCreds);

  let codeIssued = false;

  return new Promise((resolve) => {
    sock.ev.on("connection.update", (update) => {
      console.log("connection.update:", update.connection ?? "(no change)");

      if (update.connection === "open") {
        console.log("PAIRED_SUCCESSFULLY");
        setTimeout(() => resolve({ outcome: "paired", codeIssued: true }), 2000); // give saveCreds a moment to flush
      }

      if (update.connection === "close") {
        console.log("CONNECTION_CLOSED:", JSON.stringify(update.lastDisconnect?.error?.message ?? "unknown"));
        resolve({ outcome: "retry", codeIssued });
      }
    });

    if (requestCode && !sock.authState.creds.registered) {
      // requestPairingCode needs the underlying WebSocket actually
      // established — calling it immediately after makeWASocket() throws
      // "Connection Closed" (428) because the socket is still opening.
      setTimeout(() => {
        sock
          .requestPairingCode(phoneNumber)
          .then((code) => {
            codeIssued = true;
            console.log(`PAIRING_CODE: ${code}  (enter this on your phone now)`);
          })
          .catch((error) => console.error("PAIRING_CODE_REQUEST_FAILED (will retry):", error?.message ?? error));
      }, 2000);
    } else {
      console.log("waiting for pairing to complete (code already issued, or already registered) ...");
    }
  });
}

async function main() {
  const phoneNumber = process.argv[2];
  const authFolder = process.argv[3] ?? "/opt/app/data/division-report-assistant/baileys-session";

  if (!phoneNumber) {
    console.error("Usage: node pair.js <phone-number-international-no-plus> [auth-folder]");
    process.exit(1);
  }

  // Wipe any prior (possibly server-rejected) auth state before starting —
  // see the file-level doc comment. Every run gets a genuinely fresh
  // registration attempt, not a replay of whatever failed last time.
  await rm(authFolder, { recursive: true, force: true });
  console.log(`Wiped ${authFolder} — starting a fresh pairing attempt.`);

  // One code per run, a short reconnect window, then stop — per the
  // 2026-08-07 incident, don't hammer retries hoping volume helps; if
  // this fresh-state run still fails the same way, that's a real signal
  // (see file-level doc comment), not something more retries will fix.
  const maxAttempts = 6;
  const retryDelayMs = 5000;
  let codeIssued = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`--- attempt ${attempt}/${maxAttempts} ---`);
    const result = await connectAndWait(phoneNumber, authFolder, !codeIssued);
    if (result.codeIssued) codeIssued = true;
    if (result.outcome === "paired") {
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  console.error(`Did not pair after ${maxAttempts} attempts on a fresh auth state. Re-run this script for a new attempt.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
