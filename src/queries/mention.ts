/**
 * MASTER_SPEC.md §16: natural-language queries, gated behind an @-mention
 * of the bot. Deterministic pre-filter, same role as ../reports/header.ts's
 * hasReportHeader() — decide whether a message is even a query candidate
 * before spending an LLM call, per §4.5 item 1.
 *
 * TWO ways to address the bot, and both are required:
 *
 * 1. A real WhatsApp @-mention (`botMentioned`). Found live 2026-08-12
 *    after a member tagged the bot and nothing happened: WhatsApp's mention
 *    UI does NOT put the word "helper" into the message text. It inserts
 *    the mentioned party's NUMBER — "@62800000000000 saya izin hari ini" —
 *    and carries the JID separately in contextInfo.mentionedJid. Matching
 *    on text alone therefore missed every genuine tag, which is the only
 *    way most members would ever think to address a bot. The connector
 *    resolves the mention against the bot's own JID/LID; this function
 *    trusts that decision rather than re-deriving it from the text.
 *
 * 2. The literal text "@helper", for anyone who types it by hand instead
 *    of using the mention picker.
 *
 * Still deliberately NOT accepted: a bare keyword with no `@` at all.
 * header.ts's doc comment records two live incidents caused by
 * bare-keyword matching, and "helper" without `@` is at least as common in
 * ordinary Indonesian chat ("butuh helper", "siapa yang bisa jadi
 * helper"). Do not loosen this.
 */
const HELPER_TEXT_MENTION_PATTERN = /(^|\s)@helper\b/i;

/**
 * A WhatsApp mention token as it appears in the message body: `@` followed
 * by the bare number. Anchored to the start because the mention that
 * addresses the bot precedes the request — stripping `@\d+` globally would
 * also eat mentions of OTHER members later in the sentence, which are
 * meaningful content ("@helper tugas @Budi apa?") even though resolving
 * those by JID isn't implemented yet.
 */
const LEADING_MENTION_TOKENS_PATTERN = /^(?:\s*@\d+)+/;

/**
 * Returns the request text with the addressing prefix stripped, or null if
 * the message doesn't address the bot at all. A mention with nothing after
 * it ("@helper" alone) also returns null — nothing to answer.
 */
export function extractHelperQuery(text: string, botMentioned = false): string | null {
  const textMatch = HELPER_TEXT_MENTION_PATTERN.exec(text);
  if (textMatch) {
    const remainder = text.slice(textMatch.index + textMatch[0].length).trim();
    return remainder.length > 0 ? remainder : null;
  }

  if (botMentioned) {
    const remainder = text.replace(LEADING_MENTION_TOKENS_PATTERN, "").trim();
    return remainder.length > 0 ? remainder : null;
  }

  return null;
}
