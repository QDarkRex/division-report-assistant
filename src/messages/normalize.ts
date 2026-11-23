/**
 * Invisible and look-alike characters WhatsApp (and the clipboards of other
 * apps) put into message text. Found live 2026-10-03: a member re-sent his
 * corrected report three times, every line starting with U+200E (LEFT-TO-
 * RIGHT MARK — WhatsApp adds one when text is copied from an earlier
 * message). "\u200eReport Lembur Setiawan" does not start with "report", so
 * header detection failed and all three revisions were silently dropped.
 *
 * Removed outright:
 *  - U+200B..U+200F  zero-width space/joiners, LRM, RLM
 *  - U+202A..U+202E  bidi embeddings and overrides
 *  - U+2060..U+2064  word joiner and invisible operators
 *  - U+FEFF          byte-order mark / zero-width no-break space
 * Replaced by a plain space:
 *  - U+00A0          no-break space (looks like a space, is not one to a regex)
 *  - U+2007, U+2009, U+202F  figure/thin/narrow no-break space (real data: "21 V" with U+202F)
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const NBSP = /[\u00A0\u2007\u2009\u202F]/g;

export function normalizeIncomingText(text: string): string {
  return text.replace(INVISIBLE_CHARS, "").replace(NBSP, " ");
}
