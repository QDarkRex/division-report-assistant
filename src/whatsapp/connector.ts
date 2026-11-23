/**
 * Adapter interface per MASTER_SPEC.md §3.1. The Baileys-backed
 * implementation is out of scope for Phase 1 (domain layer, zero LLM/WA
 * dependency) — this type exists so `jobs/` and message-sending call sites
 * can be written against the interface ahead of the Phase 2+ adapter.
 */
export interface ConnectionStatus {
  connected: boolean;
  lastConnectedAt?: Date;
  // Chief-review finding: /healthz previously had no way to notice a dead
  // Baileys socket — the container reports "healthy" while ingesting
  // nothing. This is the readiness-gate signal (`connected`); use it in
  // ../health/routes.ts. Message-staleness ("no group message in N hours")
  // is a separate ALERTING concern, not a readiness gate — a quiet Sunday
  // is not a reason to restart the container, so that check belongs in a
  // Phase 3 scheduled job (Telegram alert), not the Docker healthcheck.
  lastMessageAt?: Date;
}

export interface SendTextInput {
  /** Where the message goes: a group JID, or a member's own JID for a direct chat. */
  chatJid: string;
  text: string;
  quotedMessageId?: string;
}

export interface SendMentionInput extends SendTextInput {
  mentionedJids: string[];
}

/**
 * A file sent into a chat. Added 2026-09-08 for the daily report export:
 * the division's report has to reach the boss's assistant, and the route
 * agreed for now is that the bot puts the .xlsx in the group and an admin
 * forwards it on.
 */
export interface SendDocumentInput {
  chatJid: string;
  /** File bytes. Held in memory — a day's report is tens of kilobytes. */
  content: Buffer;
  /** Shown as the file name in WhatsApp, and kept when forwarded. */
  fileName: string;
  mimeType: string;
  caption?: string;
}

export interface SentMessage {
  messageId: string;
  sentAt: Date;
}

export interface IncomingMessage {
  messageId: string;
  /**
   * The conversation this arrived in and the correct place to reply —
   * a group JID, or the sender's own JID for a direct chat. Named for the
   * chat rather than the group since 2026-08-29: direct messages used to be
   * dropped outright at the connector, so this could only ever hold a group,
   * and a field called `groupJid` holding a personal JID is exactly the kind
   * of thing that reads as correct while being wrong.
   */
  chatJid: string;
  senderJid: string;
  text: string;
  /** WhatsApp's own timestamp on the message — see ../messages/replay.ts. */
  messageTimestamp: Date;
  receivedAt: Date;
  /** False for a direct (1-to-1) chat with the bot. */
  isGroup: boolean;
  /**
   * True when this message @-mentions the bot through WhatsApp's own
   * mention mechanism (contextInfo.mentionedJid), as opposed to containing
   * the literal text "@helper". These are NOT the same thing and assuming
   * they were is what made every real tag silently ignored until
   * 2026-08-12 — the mention UI writes the bot's NUMBER into the text, not
   * its name. Optional so the many places that construct a plain message
   * (tests, reprocessing scripts) don't have to care; absent means "not
   * mentioned", which is the safe reading.
   */
  botMentioned?: boolean;
}

export type IncomingMessageHandler = (message: IncomingMessage) => void | Promise<void>;
export type MessageUpdateHandler = (update: { messageId: string; newText?: string; deleted?: boolean }) => void;
export type ConnectionUpdateHandler = (status: ConnectionStatus) => void;

export interface WhatsAppConnector {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendText(input: SendTextInput): Promise<SentMessage>;
  sendMention(input: SendMentionInput): Promise<SentMessage>;
  sendDocument(input: SendDocumentInput): Promise<SentMessage>;
  getConnectionStatus(): ConnectionStatus;
  onMessage(handler: IncomingMessageHandler): void;
  onMessageUpdate(handler: MessageUpdateHandler): void;
  onConnectionUpdate(handler: ConnectionUpdateHandler): void;
}
