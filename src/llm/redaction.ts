import type { AppDatabase } from "../db/types.ts";
import { memberAliases, memberIdentifiers, members, projectAliases, projects } from "../db/schema.ts";

/**
 * SECURITY_AND_PRIVACY.md §4.2 (revised 2026-08-06): two mechanisms, not
 * one vague "PII stripping" claim — regex for structured identifiers
 * (phone/JID), dictionary lookup for entities already known to this
 * system (registered members/projects). Free-text content beyond these is
 * explicitly NOT redacted — see the doc for the accepted residual risk.
 */

const JID_PATTERN = /\d{8,20}@(?:s\.whatsapp\.net|g\.us|lid)/gi;
const PHONE_PATTERN = /(?:\+?62|0)8\d{7,11}/g;

/**
 * A WhatsApp @-mention as it appears in message TEXT: "@" followed by the
 * bare number, with no @domain suffix — so JID_PATTERN above never matched
 * it. Found 2026-08-29 in a real report ("...UI nextion buatan
 * @10000000000004"), which means member LIDs have been reaching the cloud
 * LLM unredacted, against SECURITY_AND_PRIVACY.md §4.2's requirement to
 * strip JIDs before any external call. Resolving these also makes the
 * stored activity readable: it becomes the member's name instead of an
 * opaque number nobody in the division can identify.
 */
const MENTION_PATTERN = /@(\d{8,20})\b/g;

export interface StructuredRedactionResult {
  text: string;
  phoneCount: number;
  jidCount: number;
}

/** Order matters: JID first (more specific, includes @domain) — its digits would otherwise also match the phone pattern. */
export function redactStructuredIdentifiers(text: string): StructuredRedactionResult {
  let jidCount = 0;
  let phoneCount = 0;

  let result = text.replace(JID_PATTERN, () => {
    jidCount++;
    return "[JID_REDACTED]";
  });
  result = result.replace(PHONE_PATTERN, () => {
    phoneCount++;
    return "[PHONE_REDACTED]";
  });

  return { text: result, phoneCount, jidCount };
}

export interface EntityDictionaryEntry {
  pattern: string;
  replacement: string;
}

export async function buildEntityDictionary(db: AppDatabase): Promise<EntityDictionaryEntry[]> {
  const [memberRows, memberAliasRows, projectRows, projectAliasRows] = await Promise.all([
    db.select().from(members),
    db.select().from(memberAliases),
    db.select().from(projects),
    db.select().from(projectAliases),
  ]);

  const entries: EntityDictionaryEntry[] = [];
  for (const m of memberRows) entries.push({ pattern: m.preferredName, replacement: `[MEMBER:${m.memberId}]` });
  for (const a of memberAliasRows) entries.push({ pattern: a.alias, replacement: `[MEMBER:${a.memberId}]` });
  for (const p of projectRows) entries.push({ pattern: p.name, replacement: `[PROJECT:${p.projectId}]` });
  for (const a of projectAliasRows) entries.push({ pattern: a.alias, replacement: `[PROJECT:${a.projectId}]` });
  return entries;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface EntityRedactionResult {
  text: string;
  matchCount: number;
}

/** Longest pattern first so "Budi Santoso" matches before the shorter "Budi" alias would. */
export function redactKnownEntities(text: string, dictionary: readonly EntityDictionaryEntry[]): EntityRedactionResult {
  const sorted = [...dictionary].sort((a, b) => b.pattern.length - a.pattern.length);
  let result = text;
  let matchCount = 0;

  for (const entry of sorted) {
    if (!entry.pattern.trim()) continue;
    const pattern = new RegExp(`\\b${escapeRegex(entry.pattern)}\\b`, "gi");
    result = result.replace(pattern, () => {
      matchCount++;
      return entry.replacement;
    });
  }

  return { text: result, matchCount };
}

/** JID user-part (the digits before @) -> the member it belongs to. */
export type MentionDictionary = ReadonlyMap<string, string>;

/**
 * Built from member_identifiers including historical rows: a mention of a
 * number someone used before a handset change still identifies them, and
 * leaving it unresolved would send that old identifier to the LLM.
 */
export async function buildMentionDictionary(db: AppDatabase): Promise<MentionDictionary> {
  const rows = await db.select().from(memberIdentifiers);
  const byUserPart = new Map<string, string>();
  for (const row of rows) {
    const userPart = row.whatsappJid.split("@")[0];
    if (userPart) byUserPart.set(userPart, row.memberId);
  }
  return byUserPart;
}

export interface MentionRedactionResult {
  text: string;
  resolvedCount: number;
  unresolvedCount: number;
}

/**
 * Replaces @-mentions with the same [MEMBER:id] token the entity
 * dictionary produces, so downstream restore treats both identically. An
 * unrecognised number becomes a neutral placeholder rather than passing
 * through — an unknown identifier is still an identifier.
 */
export function redactMentions(text: string, dictionary: MentionDictionary): MentionRedactionResult {
  let resolvedCount = 0;
  let unresolvedCount = 0;

  const result = text.replace(MENTION_PATTERN, (_match, digits: string) => {
    const memberId = dictionary.get(digits);
    if (memberId) {
      resolvedCount++;
      return `[MEMBER:${memberId}]`;
    }
    unresolvedCount++;
    return "[MENTION_REDACTED]";
  });

  return { text: result, resolvedCount, unresolvedCount };
}

/** memberId/projectId -> the canonical display name to restore. */
export interface RestoreDictionary {
  members: ReadonlyMap<string, string>;
  projects: ReadonlyMap<string, string>;
}

export async function buildRestoreDictionary(db: AppDatabase): Promise<RestoreDictionary> {
  const [memberRows, projectRows] = await Promise.all([db.select().from(members), db.select().from(projects)]);
  return {
    members: new Map(memberRows.map((m) => [m.memberId, m.preferredName])),
    projects: new Map(projectRows.map((p) => [p.projectId, p.name])),
  };
}

/**
 * Turns the redaction tokens back into names, for text that is about to be
 * STORED — never for anything on its way out to the model.
 *
 * Redaction was always one-way, so whatever the model echoed back kept the
 * token: five stored activities read "Bantuin bang
 * [MEMBER:ff2883ed-ddeb-...]" in the database and in the Sheets date tab
 * (found 2026-08-29). The id is ours and the lookup is local, so restoring
 * it costs nothing and loses nothing.
 *
 * An id with no matching row keeps its token rather than silently becoming
 * blank — a visible oddity is easier to notice and fix than a sentence
 * with a hole in it.
 */
export function restoreEntities(text: string, dictionary: RestoreDictionary): string {
  return text
    .replace(/\[MEMBER:([0-9a-fA-F-]{36})\]/g, (match, id: string) => dictionary.members.get(id) ?? match)
    .replace(/\[PROJECT:([0-9a-fA-F-]{36})\]/g, (match, id: string) => dictionary.projects.get(id) ?? match);
}

export interface RedactionResult {
  text: string;
  redactedPhoneCount: number;
  redactedJidCount: number;
  redactedEntityCount: number;
}

export async function redactForLlm(db: AppDatabase, text: string): Promise<RedactionResult> {
  const [dictionary, mentionDictionary] = await Promise.all([buildEntityDictionary(db), buildMentionDictionary(db)]);

  // Mentions first: they carry an identifier the other two passes cannot
  // see (no @domain for JID_PATTERN, and the digits are not a name for the
  // entity dictionary), and resolving them to [MEMBER:id] lets the rest of
  // the pipeline treat a tagged member exactly like a typed one.
  const afterMentions = redactMentions(text, mentionDictionary);
  const afterEntities = redactKnownEntities(afterMentions.text, dictionary);
  const afterStructured = redactStructuredIdentifiers(afterEntities.text);

  return {
    text: afterStructured.text,
    redactedPhoneCount: afterStructured.phoneCount,
    redactedJidCount: afterStructured.jidCount + afterMentions.unresolvedCount,
    redactedEntityCount: afterEntities.matchCount + afterMentions.resolvedCount,
  };
}
