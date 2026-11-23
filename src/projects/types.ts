import type { projects } from "../db/schema.ts";

export type Project = typeof projects.$inferSelect;

export interface CreateProjectInput {
  name: string;
  createdByMemberId?: string;
}
