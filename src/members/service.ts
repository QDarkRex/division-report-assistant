import { and, eq, ilike } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { memberAliases, memberIdentifiers, members } from "../db/schema.ts";
import type { CreateMemberInput, Member, MemberLevel, MembershipStatus } from "./types.ts";

/**
 * MASTER_SPEC.md §5.2: authoritative identity is the WhatsApp JID/phone
 * mapping. A typed name is only a label — never the source of truth.
 */
export async function createMember(db: AppDatabase, input: CreateMemberInput): Promise<Member> {
  return db.transaction(async (tx) => {
    const [member] = await tx
      .insert(members)
      .values({
        preferredName: input.preferredName,
        role: input.role ?? "member",
        membershipStatus: "pending",
        reportRequired: input.reportRequired ?? true,
      })
      .returning();
    if (!member) throw new Error("member insert returned no row");

    if (input.whatsappJid) {
      await tx.insert(memberIdentifiers).values({
        memberId: member.memberId,
        whatsappJid: input.whatsappJid,
        isCurrent: true,
      });
    }

    return member;
  });
}

/** §5.2: resolve the report author from the sender JID, never from a typed name. */
export async function resolveMemberByJid(db: AppDatabase, whatsappJid: string): Promise<Member | null> {
  const rows = await db
    .select({ member: members })
    .from(memberIdentifiers)
    .innerJoin(members, eq(memberIdentifiers.memberId, members.memberId))
    .where(and(eq(memberIdentifiers.whatsappJid, whatsappJid), eq(memberIdentifiers.isCurrent, true)))
    .limit(1);
  return rows[0]?.member ?? null;
}

/**
 * A typed name in a report is only a label (§5.2) and may be ambiguous —
 * callers (LLM/command layer) decide how to handle zero or multiple matches.
 * Case-insensitive match against the preferred name or any alias.
 */
export async function resolveMembersByNameOrAlias(db: AppDatabase, text: string): Promise<Member[]> {
  const byName = await db.select().from(members).where(ilike(members.preferredName, text));
  const byAlias = await db
    .select({ member: members })
    .from(memberAliases)
    .innerJoin(members, eq(memberAliases.memberId, members.memberId))
    .where(ilike(memberAliases.alias, text));

  const seen = new Map<string, Member>();
  for (const member of byName) seen.set(member.memberId, member);
  for (const { member } of byAlias) seen.set(member.memberId, member);
  return [...seen.values()];
}

/** §14/ACCEPTANCE_TESTS.md §1.1: a display-name change preserves history — the old name becomes an alias. */
export async function renamePreferredName(db: AppDatabase, memberId: string, newPreferredName: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(members).where(eq(members.memberId, memberId)).limit(1);
    if (!current) throw new Error(`member ${memberId} not found`);
    if (current.preferredName === newPreferredName) return;

    await tx.insert(memberAliases).values({ memberId, alias: current.preferredName });
    await tx.update(members).set({ preferredName: newPreferredName, updatedAt: new Date() }).where(eq(members.memberId, memberId));
  });
}

export async function addAlias(db: AppDatabase, memberId: string, alias: string): Promise<void> {
  await db.insert(memberAliases).values({ memberId, alias });
}

/** ACCEPTANCE_TESTS.md §1.1: phone number change retains the member_id — old JID deactivated, new JID linked. */
export async function relinkWhatsappJid(db: AppDatabase, memberId: string, newJid: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(memberIdentifiers)
      .set({ isCurrent: false, unlinkedAt: new Date() })
      .where(and(eq(memberIdentifiers.memberId, memberId), eq(memberIdentifiers.isCurrent, true)));
    await tx.insert(memberIdentifiers).values({ memberId, whatsappJid: newJid, isCurrent: true });
  });
}

/** §14: never hard-delete a member — lifecycle moves through membership_status only. */
export async function setMembershipStatus(db: AppDatabase, memberId: string, status: MembershipStatus): Promise<void> {
  await db.update(members).set({ membershipStatus: status, updatedAt: new Date() }).where(eq(members.memberId, memberId));
}

export async function listActiveMembers(db: AppDatabase): Promise<Member[]> {
  return db.select().from(members).where(eq(members.membershipStatus, "active"));
}

export async function getMember(db: AppDatabase, memberId: string): Promise<Member | null> {
  const [member] = await db.select().from(members).where(eq(members.memberId, memberId)).limit(1);
  return member ?? null;
}

/** A member's level (senior/staff/magang) — used by the Saturday-overtime rule and Saturday attendance. */
export async function setMemberLevel(db: AppDatabase, memberId: string, level: MemberLevel): Promise<void> {
  await db.update(members).set({ level, updatedAt: new Date() }).where(eq(members.memberId, memberId));
}
