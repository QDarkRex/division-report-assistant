import { gt } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { messageContext } from "../db/schema.ts";

/** MASTER_SPEC.md §5.4: an untagged message may be retained as candidate context for 48 hours. Does not mutate official state. */
export async function storeCandidateContext(db: AppDatabase, messageId: string, now: Date = new Date(), ttlHours = 48): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  await db.insert(messageContext).values({ messageId, expiresAt });
}

export async function listActiveCandidateContext(db: AppDatabase, now: Date = new Date()) {
  return db.select().from(messageContext).where(gt(messageContext.expiresAt, now));
}
