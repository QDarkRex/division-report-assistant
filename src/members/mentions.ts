import { and, eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { memberIdentifiers } from "../db/schema.ts";

/**
 * Turning a list of members into a WhatsApp message that actually pings
 * them.
 *
 * A mention is two things at once, and both are required: the literal text
 * `@<number>` inside the message body, and the full JID in the message's
 * `mentions` array. Text alone renders as a plain string nobody is
 * notified about; the array alone highlights nothing. This is the same
 * asymmetry that hid every incoming mention from the bot until 2026-08-12
 * — see queries/mention.ts — only in the outbound direction.
 *
 * The number in the text must be the JID's local part, which in this group
 * is a LID, not a phone number. WhatsApp renders it as the participant's
 * display name, so the message reads as names even though it is written as
 * digits.
 */
export interface Mentionable {
  memberId: string;
  preferredName: string;
  jid: string;
}

/** `@` plus the JID's local part — the exact form WhatsApp resolves to a name. */
export function mentionToken(jid: string): string {
  return `@${jid.split("@")[0]}`;
}

/**
 * Current JIDs for the given members, skipping anyone who has none.
 *
 * Skipping rather than failing is deliberate: a member whose identifier was
 * never linked (or was unlinked on a number change) must not stop the whole
 * reminder from going out. The caller names them in the text without a
 * mention instead — being un-pingable is not the same as being excluded.
 */
export async function resolveMentionables(
  db: AppDatabase,
  members: ReadonlyArray<{ memberId: string; preferredName: string }>,
): Promise<Mentionable[]> {
  if (members.length === 0) return [];

  const rows = await db
    .select({ memberId: memberIdentifiers.memberId, jid: memberIdentifiers.whatsappJid })
    .from(memberIdentifiers)
    .where(and(inArray(memberIdentifiers.memberId, members.map((m) => m.memberId)), eq(memberIdentifiers.isCurrent, true)));

  const jidByMemberId = new Map(rows.map((r) => [r.memberId, r.jid]));
  return members
    .map((member) => {
      const jid = jidByMemberId.get(member.memberId);
      return jid ? { memberId: member.memberId, preferredName: member.preferredName, jid } : null;
    })
    .filter((m): m is Mentionable => m !== null);
}

/** Lead line of the missing-reporters reminder: sits on its own line, with the mentions on the next. */
export const REPORT_REMINDER_LEAD = "⏰ *Belum lapor hari ini*";

export interface MentionMessage {
  text: string;
  mentionedJids: string[];
}

/**
 * Builds `<lead>`, then `@a @b @c` on the next line, then `<tail>`, mentioning everyone who can be
 * mentioned and naming everyone who cannot.
 *
 * Un-mentionable members are listed by name at the end rather than dropped.
 * A reminder that quietly omits someone because of a missing identifier row
 * is worse than one that names them without a ping: the first looks like
 * they were not expected to report.
 */
export function buildMentionMessage(
  lead: string,
  members: ReadonlyArray<{ memberId: string; preferredName: string }>,
  mentionables: readonly Mentionable[],
  tail = "",
): MentionMessage {
  const mentionableIds = new Set(mentionables.map((m) => m.memberId));
  const unmentionable = members.filter((m) => !mentionableIds.has(m.memberId));

  const parts = [lead, mentionables.map((m) => mentionToken(m.jid)).join(" ")].filter((p) => p.length > 0);
  if (unmentionable.length > 0) {
    parts.push(`(tanpa tag: ${unmentionable.map((m) => m.preferredName).join(", ")})`);
  }

  return { text: `${parts.join("\n")}${tail}`, mentionedJids: mentionables.map((m) => m.jid) };
}
