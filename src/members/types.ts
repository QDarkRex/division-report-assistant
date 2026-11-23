import type { members } from "../db/schema.ts";

export type Member = typeof members.$inferSelect;
export type MembershipStatus = Member["membershipStatus"];
export type MemberRole = Member["role"];
export type MemberLevel = Member["level"];

export interface CreateMemberInput {
  preferredName: string;
  role?: MemberRole;
  whatsappJid?: string;
  reportRequired?: boolean;
}
