import makeWASocket, {
  areJidsSameUser,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "baileys";
import type { WASocket, WAMessage } from "baileys";
import { Boom } from "@hapi/boom";
import type {
  ConnectionStatus,
  ConnectionUpdateHandler,
  IncomingMessage,
  IncomingMessageHandler,
  MessageUpdateHandler,
  SendDocumentInput,
  SendMentionInput,
  SendTextInput,
  SentMessage,
  WhatsAppConnector,
} from "./connector.ts";

/**
 * Baileys-backed implementation of ../whatsapp/connector.ts's adapter
 * interface. Written and typechecked against the real `baileys` package
 * types. `connect()` pins `version`/`browser` the same way `pair.ts` does —
 * root-caused there (2026-08-07) as a real contributor to connection
 * failures, not optional. Still UNVERIFIED against the actual paired
 * session (number 62800000000000, volume
 * `division-report-assistant_wdh-data`) — connecting this class
 * (not pair.ts) to that session is the next manual step before deploy.
 *
 * Known gaps, not silently glossed over:
 * - `sendText`/`sendMention`'s `quotedMessageId` is accepted by the
 *   interface but not wired here — Baileys' quote API needs the full
 *   original WAMessage object, not just an id, which would require a
 *   recent-message cache this class doesn't keep yet.
 * - Outage-interval recording (ARCHITECTURE_PROPOSAL.md §7: log the
 *   outage, announce on reconnect) is NOT done inside this adapter — it
 *   only exposes accurate `ConnectionStatus` via `onConnectionUpdate`.
 *   Whoever wires this connector into the scheduler/pipeline is
 *   responsible for writing to the `connection_outages` table and
 *   sending the announcement.
 * - Media BINARY content is never downloaded — only the caption text is
 *   read (see extractText). A photo of a panel attached to a report is
 *   not analyzed; its caption is what becomes the report.
 */
export interface BaileysConnectorOptions {
  /** Session persistence path — MASTER_SPEC.md §5.1: encrypted auth state, no auth in Git. */
  authStateFolder: string;
  /**
   * The one group this bot answers in. Every other group is dropped before
   * the pipeline sees it.
   *
   * Until 2026-09-08 nothing checked which group a message arrived from:
   * WHATSAPP_GROUP_JID was used only to address OUTBOUND scheduled
   * messages. A recognised division member could therefore ask the bot for
   * division data from any group the bot had been added to, and the answer
   * went back to that group, in front of whoever else was in it. Raised by
   * an external audit; no leak was demonstrated, and it depends entirely on
   * the bot being added elsewhere — which nothing prevents, since anyone
   * can add a number to a group.
   *
   * Direct chats stay open regardless: the owner uses them to send meeting
   * minutes privately, and pipeline.ts still rejects any sender who is not
   * an active member.
   */
  allowedGroupJid: string;
  /** Reconnect backoff, per ARCHITECTURE_PROPOSAL.md §7. */
  reconnectDelayMs?: number;
  /** Injectable for testing — defaults to the real Baileys socket/auth-state factories. */
  socketFactory?: typeof makeWASocket;
  authStateFactory?: typeof useMultiFileAuthState;
  versionFactory?: typeof fetchLatestBaileysVersion;
}

/**
 * Found live 2026-08-10: members routinely send a daily report as a PHOTO
 * or VIDEO with the report text in the caption ("report\n- pasang panel
 * ..."), and every one of those was silently dropped — this function only
 * read `conversation`/`extendedTextMessage`, so toIncomingMessage()
 * returned null and the message never reached the pipeline at all. No
 * error, no acknowledgment, no database row: from the member's side the
 * bot simply ignored them. Captions are the same report text typed in a
 * different WhatsApp affordance and must be treated identically.
 *
 * normalizeMessageContent() unwraps the container types WhatsApp uses for
 * disappearing messages (`ephemeralMessage`), view-once media, edits, and
 * `documentWithCaptionMessage` — without it, a report sent in a group with
 * disappearing messages enabled would be dropped for the same reason.
 */
function extractText(message: WAMessage): string | null {
  const content = normalizeMessageContent(message.message);
  if (!content) return null;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

/**
 * The JIDs listed in the message's contextInfo, across every content type
 * that can carry one (a caption can @-mention just like a text message).
 */
function extractMentionedJids(message: WAMessage): string[] {
  const content = normalizeMessageContent(message.message);
  if (!content) return [];
  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo;
  return contextInfo?.mentionedJid ?? [];
}

function toIncomingMessage(message: WAMessage, selfJids: readonly string[], allowedGroupJid: string): IncomingMessage | null {
  const chatJid = message.key.remoteJid;
  // In a group, `participant` is the actual human; in a direct chat there is
  // no participant and remoteJid IS the sender.
  const senderJid = message.key.participant ?? message.key.remoteJid;
  const text = extractText(message);
  const messageId = message.key.id;
  const timestampRaw = message.messageTimestamp;

  // The bot's own sends come back through messages.upsert. They must never
  // re-enter the pipeline as member input: the helper's own number is a
  // group participant and was seeded into `members` by seed-members.ts
  // along with every other participant (owner confirmed 2026-08-13), so
  // without this the bot is a recognised active "member" reading its own
  // acknowledgments and summaries back. Nothing it currently sends carries
  // a report header, which is the only reason this has been harmless.
  if (message.key.fromMe) return null;

  // Direct chats are accepted as of 2026-08-29 (owner wants to send meeting
  // minutes and updates to the bot privately rather than into the group).
  // They used to be rejected outright here. Opening them is safe because
  // pipeline.ts still resolves the sender against `members` and returns
  // `unrecognized_sender` for anyone else — and acknowledgment.ts returns
  // null for that outcome, so a stranger messaging this number gets total
  // silence rather than a reply confirming a bot is on the other end.
  if (!chatJid || !senderJid || !text || !messageId || timestampRaw === null || timestampRaw === undefined) {
    return null;
  }

  // A group that is not THE group is not ours to read or answer in.
  // Dropped here rather than in the pipeline so nothing downstream can
  // accidentally reply into it: the reply address is taken from the
  // incoming message, so a message that never arrives can never be
  // answered in the wrong place.
  if ((isJidGroup(chatJid) ?? false) && chatJid !== allowedGroupJid) {
    return null;
  }

  // areJidsSameUser ignores the device suffix (`:12@s.whatsapp.net`) that
  // socket.user.id carries but a mention never does. Both the phone-number
  // JID and the LID are compared because this group addresses participants
  // by LID — a mention there lists the LID, which would never equal the
  // bot's @s.whatsapp.net identity.
  const mentionedJids = extractMentionedJids(message);
  const botMentioned = mentionedJids.some((mentioned) => selfJids.some((self) => areJidsSameUser(mentioned, self)));

  const messageTimestamp = new Date(Number(timestampRaw) * 1000);
  return { messageId, chatJid, senderJid, text, messageTimestamp, receivedAt: new Date(), isGroup: isJidGroup(chatJid) ?? false, botMentioned };
}

export class BaileysConnector implements WhatsAppConnector {
  private socket: WASocket | undefined;
  private status: ConnectionStatus = { connected: false };
  private readonly messageHandlers: IncomingMessageHandler[] = [];
  private readonly updateHandlers: MessageUpdateHandler[] = [];
  private readonly connectionHandlers: ConnectionUpdateHandler[] = [];
  private stopped = false;

  constructor(private readonly options: BaileysConnectorOptions) {}

  async connect(): Promise<void> {
    this.stopped = false;
    const authStateFactory = this.options.authStateFactory ?? useMultiFileAuthState;
    const socketFactory = this.options.socketFactory ?? makeWASocket;
    const versionFactory = this.options.versionFactory ?? fetchLatestBaileysVersion;
    const { state, saveCreds } = await authStateFactory(this.options.authStateFolder);
    const { version } = await versionFactory();
    const socket = socketFactory({
      auth: state,
      version,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
    });
    this.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        this.status = { connected: true, lastConnectedAt: new Date() };
      } else if (update.connection === "close") {
        this.status = { ...this.status, connected: false };
        const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (!loggedOut && !this.stopped) {
          // unref: a scheduled reconnect must never keep the Node process
          // (or a test run) alive on its own.
          setTimeout(() => void this.connect(), this.options.reconnectDelayMs ?? 5000).unref();
        }
      }
      for (const handler of this.connectionHandlers) handler(this.status);
    });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      // Read per batch, not once at connect: socket.user is populated by
      // the login handshake, which completes after connect() returns.
      const selfJids = [socket.user?.id, socket.user?.lid, socket.user?.jid].filter((jid): jid is string => Boolean(jid));
      for (const raw of messages) {
        const incoming = toIncomingMessage(raw, selfJids, this.options.allowedGroupJid);
        if (!incoming) continue;
        this.status = { ...this.status, lastMessageAt: incoming.receivedAt };
        for (const handler of this.messageHandlers) void handler(incoming);
      }
    });

    socket.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        const messageId = update.key.id;
        if (!messageId) continue;
        for (const handler of this.updateHandlers) {
          handler({ messageId, deleted: update.update.messageStubType !== undefined });
        }
      }
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.socket?.end(undefined);
    this.socket = undefined;
    this.status = { ...this.status, connected: false };
  }

  async sendText(input: SendTextInput): Promise<SentMessage> {
    if (!this.socket) throw new Error("BaileysConnector: not connected");
    const sent = await this.socket.sendMessage(input.chatJid, { text: input.text });
    if (!sent?.key.id) throw new Error("BaileysConnector: send did not return a message id");
    return { messageId: sent.key.id, sentAt: new Date() };
  }

  async sendMention(input: SendMentionInput): Promise<SentMessage> {
    if (!this.socket) throw new Error("BaileysConnector: not connected");
    const sent = await this.socket.sendMessage(input.chatJid, { text: input.text, mentions: input.mentionedJids });
    if (!sent?.key.id) throw new Error("BaileysConnector: send did not return a message id");
    return { messageId: sent.key.id, sentAt: new Date() };
  }

  async sendDocument(input: SendDocumentInput): Promise<SentMessage> {
    if (!this.socket) throw new Error("BaileysConnector: not connected");
    const sent = await this.socket.sendMessage(input.chatJid, {
      document: input.content,
      fileName: input.fileName,
      mimetype: input.mimeType,
      ...(input.caption ? { caption: input.caption } : {}),
    });
    if (!sent?.key.id) throw new Error("BaileysConnector: send did not return a message id");
    return { messageId: sent.key.id, sentAt: new Date() };
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onMessageUpdate(handler: MessageUpdateHandler): void {
    this.updateHandlers.push(handler);
  }

  onConnectionUpdate(handler: ConnectionUpdateHandler): void {
    this.connectionHandlers.push(handler);
  }
}
