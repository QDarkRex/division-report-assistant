import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { BaileysConnector } from "./baileys-connector.ts";

/**
 * Fake socket shaped just enough like Baileys' WASocket for the adapter's
 * own usage (ev.on/emit, sendMessage, end) — this tests the adapter's
 * event-translation logic without a live WhatsApp connection, which this
 * session cannot establish (see baileys-connector.ts's doc comment).
 */
function fakeSocket() {
  const ev = new EventEmitter();
  const sent: Array<{ jid: string; content: unknown }> = [];
  let ended = false;
  const socket = {
    // Baileys populates this from the login handshake; the connector reads
    // it to decide whether a mention addresses the bot. The device suffix
    // on `id` is deliberate — real sockets carry one, mentions never do.
    user: { id: '62800000000000:12@s.whatsapp.net', lid: '99887766554433@lid', jid: '62800000000000@s.whatsapp.net' },
    ev: {
      on: (event: string, handler: (...args: unknown[]) => void) => ev.on(event, handler),
    },
    sendMessage: async (jid: string, content: unknown) => {
      sent.push({ jid, content });
      return { key: { id: `sent-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    end: () => {
      ended = true;
    },
  };
  return { socket, ev, sent, isEnded: () => ended };
}

function fakeAuthState() {
  return async () => ({ state: {} as never, saveCreds: async () => {} });
}

function fakeVersionFactory() {
  return async () => ({ version: [2, 3000, 0] as [number, number, number], isLatest: true });
}

test("connection.update to open marks the connector connected", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });

  await connector.connect();
  assert.equal(connector.getConnectionStatus().connected, false);

  ev.emit("connection.update", { connection: "open" });
  assert.equal(connector.getConnectionStatus().connected, true);
});

test("a group text message is translated to IncomingMessage and dispatched", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: unknown[] = [];
  connector.onMessage((message) => {
    received.push(message);
  });

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000000000@g.us", participant: "628111@s.whatsapp.net", id: "wa-1" },
        message: { conversation: "report\n- cek panel" },
        messageTimestamp: 1754535600, // 2025-08-07T03:00:00Z-ish, exact value doesn't matter for this test
      },
    ],
  });

  assert.equal(received.length, 1);
  const message = received[0] as { messageId: string; chatJid: string; senderJid: string; text: string; isGroup: boolean };
  assert.equal(message.messageId, "wa-1");
  assert.equal(message.chatJid, "120363000000000000@g.us");
  assert.equal(message.isGroup, true);
  assert.equal(message.senderJid, "628111@s.whatsapp.net");
  assert.equal(message.text, "report\n- cek panel");
});

// Found live 2026-08-10: members send reports as a photo/video with the
// report text in the caption, and every one was silently dropped.
function dispatchOne(messageContent: unknown): Array<{ text: string }> {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  const received: Array<{ text: string }> = [];
  void connector.connect().then(() => {
    connector.onMessage((message) => void received.push(message as { text: string }));
    ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "120363000000000000@g.us", participant: "628111@s.whatsapp.net", id: "wa-media" },
          message: messageContent,
          messageTimestamp: 1754535600,
        },
      ],
    });
  });
  return received;
}

test("a report sent as a photo caption is dispatched, not dropped", async () => {
  const received = dispatchOne({ imageMessage: { caption: "report\n- pasang panel B", mimetype: "image/jpeg" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "report\n- pasang panel B");
});

test("a report sent as a video caption is dispatched", async () => {
  const received = dispatchOne({ videoMessage: { caption: "report\n- test docking charge", mimetype: "video/mp4" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "report\n- test docking charge");
});

test("a photo with no caption stays ignored — there is no text to process", async () => {
  const received = dispatchOne({ imageMessage: { mimetype: "image/jpeg" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 0);
});

// Disappearing-message groups wrap every message in ephemeralMessage;
// without normalizeMessageContent() the unwrapping never happens and even
// a plain-text report is dropped.
test("a report inside an ephemeral (disappearing-message) wrapper is unwrapped and dispatched", async () => {
  const received = dispatchOne({ ephemeralMessage: { message: { conversation: "report\n- cek panel" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, "report\n- cek panel");
});

// Reversed 2026-08-29: direct chats used to be rejected at the connector.
// The owner wants to send meeting minutes and updates to the bot privately
// instead of into the group, so a 1-to-1 message must now reach the
// pipeline — which still gates on the sender being a known active member.
test("a direct (non-group) message IS dispatched, flagged as not a group", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: Array<{ chatJid: string; senderJid: string; isGroup: boolean }> = [];
  connector.onMessage((message) => void received.push(message as never));

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "628111@s.whatsapp.net", fromMe: false, id: "wa-dm" },
        message: { conversation: "notulensi meeting senin" },
        messageTimestamp: 1754535600,
      },
    ],
  });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.isGroup, false);
  // In a direct chat there is no `participant` — remoteJid is both the
  // conversation and the sender, and replies go back to that same JID.
  assert.equal(received[0]?.chatJid, "628111@s.whatsapp.net");
  assert.equal(received[0]?.senderJid, "628111@s.whatsapp.net");
});

test("a message-history-sync batch (type != notify) is not dispatched", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: unknown[] = [];
  connector.onMessage((message) => void received.push(message));

  ev.emit("messages.upsert", {
    type: "append",
    messages: [
      {
        key: { remoteJid: "120363000000000000@g.us", participant: "628111@s.whatsapp.net", id: "wa-3" },
        message: { conversation: "old history message" },
        messageTimestamp: 1754535600,
      },
    ],
  });

  assert.equal(received.length, 0);
});

test("sendText calls the socket with the expected jid and text", async () => {
  const { socket, sent } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const result = await connector.sendText({ chatJid: "120363000000000000@g.us", text: "Ringkasan pagi" });
  assert.equal(result.messageId, "sent-1");
  assert.deepEqual(sent, [{ jid: "120363000000000000@g.us", content: { text: "Ringkasan pagi" } }]);
});

test("sendMention includes the mentioned JIDs", async () => {
  const { socket, sent } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  await connector.sendMention({
    chatJid: "120363000000000000@g.us",
    text: "Halo @Budi",
    mentionedJids: ["628111@s.whatsapp.net"],
  });
  assert.deepEqual(sent, [
    { jid: "120363000000000000@g.us", content: { text: "Halo @Budi", mentions: ["628111@s.whatsapp.net"] } },
  ]);
});

test("disconnect ends the socket and marks the connector disconnected", async () => {
  const { socket, ev, isEnded } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();
  ev.emit("connection.update", { connection: "open" });
  assert.equal(connector.getConnectionStatus().connected, true);

  await connector.disconnect();
  assert.equal(isEnded(), true);
  assert.equal(connector.getConnectionStatus().connected, false);
});

test("onConnectionUpdate handlers are notified on every connection.update event", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const updates: boolean[] = [];
  connector.onConnectionUpdate((status) => updates.push(status.connected));

  ev.emit("connection.update", { connection: "open" });
  ev.emit("connection.update", { connection: "close" });

  assert.deepEqual(updates, [true, false]);
});

// The other half of the 2026-08-12 mention fix: the connector must resolve
// contextInfo.mentionedJid against the bot's OWN identity. Everything above
// only proves the text parsing; if this half is wrong, botMentioned is
// always false and no real tag is ever recognised.
function dispatchOneRaw(messageContent: unknown): Array<{ botMentioned?: boolean; text: string }> {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  const received: Array<{ botMentioned?: boolean; text: string }> = [];
  void connector.connect().then(() => {
    connector.onMessage((message) => void received.push(message as { botMentioned?: boolean; text: string }));
    ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "120363000000000000@g.us", participant: "628111@s.whatsapp.net", id: "wa-mention" },
          message: messageContent,
          messageTimestamp: 1754535600,
        },
      ],
    });
  });
  return received;
}

test("a mention of the bot's phone JID sets botMentioned, despite the socket's device suffix", async () => {
  const received = dispatchOneRaw({
    extendedTextMessage: {
      text: "@62800000000000 saya izin hari ini",
      contextInfo: { mentionedJid: ["62800000000000@s.whatsapp.net"] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0]?.botMentioned, true);
});

test("a mention of the bot's LID also counts — this group addresses participants by LID", async () => {
  const received = dispatchOneRaw({
    extendedTextMessage: { text: "@99887766554433 saya sakit", contextInfo: { mentionedJid: ["99887766554433@lid"] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0]?.botMentioned, true);
});

test("a mention of a DIFFERENT member does not set botMentioned", async () => {
  const received = dispatchOneRaw({
    extendedTextMessage: { text: "@628999 tolong dicek", contextInfo: { mentionedJid: ["628999@s.whatsapp.net"] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0]?.botMentioned, false);
});

test("a mention carried on a photo caption is detected too", async () => {
  const received = dispatchOneRaw({
    imageMessage: { caption: "@62800000000000 ini fotonya", contextInfo: { mentionedJid: ["62800000000000@s.whatsapp.net"] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0]?.botMentioned, true);
  assert.equal(received[0]?.text, "@62800000000000 ini fotonya");
});

test("a plain message with no contextInfo has botMentioned false, not undefined-crashing", async () => {
  const received = dispatchOneRaw({ conversation: "halo semua" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received[0]?.botMentioned, false);
});

// The helper's own number is a group participant and was seeded into
// `members` alongside everyone else (owner confirmed 2026-08-13), so the
// bot is a recognised active "member". Without this filter it reads its
// own acknowledgments and summaries back in as member input.
test("the bot's own sent messages are not dispatched back into the pipeline", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: unknown[] = [];
  connector.onMessage((message) => void received.push(message));

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000000000@g.us", fromMe: true, id: "wa-self" },
        message: { conversation: "Ringkasan pagi — 3 task aktif" },
        messageTimestamp: 1754535600,
      },
    ],
  });

  assert.equal(received.length, 0);
});

// Raised by an external audit, 2026-09-08: nothing checked WHICH group a
// message came from. WHATSAPP_GROUP_JID only addressed outbound scheduled
// messages, so a recognised member could ask the bot for division data
// from any group the bot had been added to, and the answer went back into
// that group in front of everyone in it.
test("a message from a group that is not the configured one never reaches the pipeline", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: unknown[] = [];
  connector.onMessage((message) => {
    received.push(message);
  });

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363999999999999@g.us", participant: "628111@s.whatsapp.net", id: "wa-other-group" },
        message: { conversation: "report\n- cek panel" },
        messageTimestamp: 1754535600,
      },
    ],
  });

  assert.equal(received.length, 0);
});

// Direct chats stay open on purpose: the owner sends meeting minutes and
// updates to the bot privately, and pipeline.ts still rejects anyone who
// is not an active member.
test("a direct chat is still accepted while other groups are not", async () => {
  const { socket, ev } = fakeSocket();
  const connector = new BaileysConnector({
    authStateFolder: "/tmp/unused",
    allowedGroupJid: "120363000000000000@g.us",
    authStateFactory: fakeAuthState(),
    socketFactory: () => socket as never,
    versionFactory: fakeVersionFactory(),
  });
  await connector.connect();

  const received: Array<{ isGroup: boolean }> = [];
  connector.onMessage((message) => {
    received.push(message as { isGroup: boolean });
  });

  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "628111@s.whatsapp.net", id: "wa-dm" },
        message: { conversation: "notulensi meeting senin" },
        messageTimestamp: 1754535600,
      },
    ],
  });

  assert.equal(received.length, 1);
  assert.equal(received[0]?.isGroup, false);
});
