import { eq, ilike } from "drizzle-orm";
import type { AppDatabase } from "../db/types.ts";
import { projectAliases, projects } from "../db/schema.ts";
import type { CreateProjectInput, Project } from "./types.ts";

/**
 * MASTER_SPEC.md §17 lists only `projects`/`project_aliases` (no separate
 * candidate-project table like candidate_tasks has), so the confirmation
 * workflow is modeled as a `confirmed` flag on the project row itself
 * rather than a parallel candidate entity.
 */
export async function createProject(db: AppDatabase, input: CreateProjectInput): Promise<Project> {
  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      confirmed: false,
      createdByMemberId: input.createdByMemberId,
    })
    .returning();
  if (!project) throw new Error("project insert returned no row");
  return project;
}

export async function confirmProject(db: AppDatabase, projectId: string): Promise<void> {
  await db.update(projects).set({ confirmed: true, updatedAt: new Date() }).where(eq(projects.projectId, projectId));
}

export async function renameProject(db: AppDatabase, projectId: string, newName: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (!current) throw new Error(`project ${projectId} not found`);
    if (current.name === newName) return;

    await tx.insert(projectAliases).values({ projectId, alias: current.name });
    await tx.update(projects).set({ name: newName, updatedAt: new Date() }).where(eq(projects.projectId, projectId));
  });
}

export async function addProjectAlias(db: AppDatabase, projectId: string, alias: string): Promise<void> {
  await db.insert(projectAliases).values({ projectId, alias });
}

export async function resolveProjectsByNameOrAlias(db: AppDatabase, text: string): Promise<Project[]> {
  const byName = await db.select().from(projects).where(ilike(projects.name, text));
  const byAlias = await db
    .select({ project: projects })
    .from(projectAliases)
    .innerJoin(projects, eq(projectAliases.projectId, projects.projectId))
    .where(ilike(projectAliases.alias, text));

  const seen = new Map<string, Project>();
  for (const project of byName) seen.set(project.projectId, project);
  for (const { project } of byAlias) seen.set(project.projectId, project);
  return [...seen.values()];
}

export async function listUnconfirmedProjects(db: AppDatabase): Promise<Project[]> {
  return db.select().from(projects).where(eq(projects.confirmed, false));
}

export async function getProject(db: AppDatabase, projectId: string): Promise<Project | null> {
  const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return project ?? null;
}
