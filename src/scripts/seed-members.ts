import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.ts";
import { createMember, setMembershipStatus } from "../members/service.ts";

/**
 * One-off seed script — NOT part of the running app. Members were never
 * onboardable through WhatsApp (no chat command exists for it), and the
 * bot was live with zero rows in `members`, so every message resolved to
 * `unrecognized_sender` and was silently dropped. This seeds the current
 * "Grup Divisi🔥" roster (JIDs pulled via list-participants.ts, 2026-08-07)
 * as `active` members under placeholder names — waiting for all 24 real
 * names before the bot does anything defeats the point of seeding at all.
 * Rename each one later with rename-member.ts as real names are supplied.
 *
 * createMember() defaults membershipStatus to "pending" — found
 * 2026-08-07 that a seed script calling only createMember() would leave
 * the bot still inert, since pipeline.ts only accepts senders whose
 * membershipStatus is "active". This script explicitly promotes every
 * seeded member.
 *
 * Only Affan (the owner, confirmed via a live test message's recorded
 * sender_jid, 2026-08-07) is seeded with the app's `admin` role. WhatsApp's
 * own group-admin flag (captured as a comment below, from
 * list-participants.ts's output) is NOT auto-mapped onto the app's admin
 * role — those are different authorities (WA group moderation vs. this
 * bot's cancel/pause/conflict-resolution permissions) and granting the
 * latter needs an explicit decision, not an assumption from the former.
 *
 * Usage: node dist/scripts/seed-members.js
 */
const ROSTER: Array<{ jid: string; name: string; role: "member" | "admin"; waGroupRole: string }> = [
  { jid: "10000000000001@lid", name: "Anggota-01", role: "member", waGroupRole: "member" },
  { jid: "10000000000002@lid", name: "Anggota-02", role: "member", waGroupRole: "admin" },
  { jid: "10000000000003@lid", name: "Anggota-03", role: "member", waGroupRole: "member" },
  { jid: "10000000000004@lid", name: "Anggota-04", role: "member", waGroupRole: "admin" },
  { jid: "10000000000005@lid", name: "Anggota-05", role: "member", waGroupRole: "admin" },
  { jid: "10000000000006@lid", name: "Anggota-06", role: "member", waGroupRole: "member" },
  { jid: "10000000000007@lid", name: "Anggota-07", role: "member", waGroupRole: "member" },
  { jid: "10000000000008@lid", name: "Anggota-08", role: "member", waGroupRole: "member" },
  { jid: "10000000000009@lid", name: "Anggota-09", role: "member", waGroupRole: "member" },
  { jid: "10000000000010@lid", name: "Anggota-10", role: "member", waGroupRole: "member" },
  { jid: "10000000000011@lid", name: "Anggota-11", role: "member", waGroupRole: "member" },
  { jid: "10000000000012@lid", name: "Anggota-12", role: "member", waGroupRole: "member" },
  { jid: "10000000000013@lid", name: "Anggota-13", role: "member", waGroupRole: "member" },
  { jid: "10000000000014@lid", name: "Anggota-14", role: "member", waGroupRole: "member" },
  { jid: "10000000000015@lid", name: "Anggota-15", role: "member", waGroupRole: "member" },
  { jid: "10000000000016@lid", name: "Affan", role: "admin", waGroupRole: "admin" },
  { jid: "10000000000017@lid", name: "Anggota-16", role: "member", waGroupRole: "member" },
  { jid: "10000000000018@lid", name: "Anggota-17", role: "member", waGroupRole: "member" },
  { jid: "10000000000019@lid", name: "Anggota-18", role: "member", waGroupRole: "superadmin" },
  { jid: "10000000000020@lid", name: "Anggota-19", role: "member", waGroupRole: "member" },
  { jid: "10000000000021@lid", name: "Anggota-20", role: "member", waGroupRole: "member" },
  { jid: "10000000000022@lid", name: "Anggota-21", role: "member", waGroupRole: "member" },
  { jid: "10000000000023@lid", name: "Anggota-22", role: "member", waGroupRole: "admin" },
  { jid: "10000000000024@lid", name: "Anggota-23", role: "member", waGroupRole: "member" },
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  for (const entry of ROSTER) {
    const member = await createMember(db, { preferredName: entry.name, role: entry.role, whatsappJid: entry.jid });
    await setMembershipStatus(db, member.memberId, "active");
    console.log(`SEEDED: ${entry.name}\trole=${entry.role}\tstatus=active\twa_group_role=${entry.waGroupRole}`);
  }

  console.log(`DONE: ${ROSTER.length} members seeded and activated.`);
  await pool.end();
}

main().catch((error) => {
  console.error("SEED_ERROR:", error);
  process.exit(1);
});
