import type { AppDatabase } from "../db/types.ts";
import { projectAliases, projects } from "../db/schema.ts";

/**
 * Resolves free report text to at most ONE project, or nothing.
 *
 * Separate from resolveProjectsByNameOrAlias, which does an exact ilike:
 * that works when a member types a project name into a query, but never
 * matches inside a sentence, so "Soldering PCB BMS Epsilon" resolved to
 * nothing and the Sheets date tab's Proyek column stayed empty for every
 * item that had no task. This matches project names and aliases as whole
 * words anywhere in the text.
 *
 * Two or more distinct projects matching returns null, deliberately. The
 * owner confirmed 2026-08-31 that "lifter" and "antenna tracker" each
 * exist in BOTH the Alpha and Beta dockings — and was unsure about
 * the second one themselves. Text that genuinely points at two projects
 * is not a tie to be broken by a rule; it is a question for a human, and
 * a wrong attribution here would surface months later as a project total
 * nobody can reconcile.
 */
export interface ProjectMatch {
  projectId: string;
  name: string;
  /** The name or alias that matched — the evidence, for review and logging. */
  matchedTerm: string;
}

interface ProjectTerms {
  projectId: string;
  name: string;
  terms: string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function loadProjectTerms(db: AppDatabase): Promise<ProjectTerms[]> {
  const [projectRows, aliasRows] = await Promise.all([db.select().from(projects), db.select().from(projectAliases)]);

  const byId = new Map<string, ProjectTerms>();
  for (const project of projectRows) {
    byId.set(project.projectId, { projectId: project.projectId, name: project.name, terms: [project.name] });
  }
  for (const alias of aliasRows) byId.get(alias.projectId)?.terms.push(alias.alias);
  return [...byId.values()];
}

/**
 * Pure so the resolution rule can be tested without a database — the rule
 * is the part worth testing, not the query.
 *
 * Longest matching term wins WITHIN a project (the most specific evidence
 * is the most useful to show), but across projects any second match kills
 * the result rather than ranking them.
 */
export function matchProjectInText(text: string, allTerms: readonly ProjectTerms[]): ProjectMatch | null {
  const hits: ProjectMatch[] = [];

  for (const project of allTerms) {
    let best: string | null = null;
    for (const term of project.terms) {
      if (!term.trim()) continue;
      if (new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(text)) {
        if (!best || term.length > best.length) best = term;
      }
    }
    if (best) hits.push({ projectId: project.projectId, name: project.name, matchedTerm: best });
  }

  return hits.length === 1 ? (hits[0] ?? null) : null;
}
