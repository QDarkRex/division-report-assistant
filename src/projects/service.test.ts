import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestDb } from "../db/testing.ts";
import { createMember } from "../members/service.ts";
import {
  addProjectAlias,
  confirmProject,
  createProject,
  getProject,
  listUnconfirmedProjects,
  renameProject,
  resolveProjectsByNameOrAlias,
} from "./service.ts";

test("a newly created project starts unconfirmed", async () => {
  const db = await createTestDb();
  const project = await createProject(db, { name: "Panel Upgrade" });
  assert.equal(project.confirmed, false);
  const unconfirmed = await listUnconfirmedProjects(db);
  assert.deepEqual(
    unconfirmed.map((p) => p.projectId),
    [project.projectId],
  );
});

test("confirming a project removes it from the unconfirmed list", async () => {
  const db = await createTestDb();
  const project = await createProject(db, { name: "Panel Upgrade" });
  await confirmProject(db, project.projectId);

  const stored = await getProject(db, project.projectId);
  assert.equal(stored?.confirmed, true);
  assert.deepEqual(await listUnconfirmedProjects(db), []);
});

test("project created by a member records the creator", async () => {
  const db = await createTestDb();
  const admin = await createMember(db, { preferredName: "Admin One", role: "admin" });
  const project = await createProject(db, { name: "Substation Repair", createdByMemberId: admin.memberId });
  assert.equal(project.createdByMemberId, admin.memberId);
});

test("renaming a project preserves the old name as an alias, resolvable by either", async () => {
  const db = await createTestDb();
  const project = await createProject(db, { name: "Panel Upgrade" });
  await renameProject(db, project.projectId, "Panel Upgrade Phase 2");

  const byOldName = await resolveProjectsByNameOrAlias(db, "Panel Upgrade");
  assert.deepEqual(
    byOldName.map((p) => p.projectId),
    [project.projectId],
  );

  const byNewName = await resolveProjectsByNameOrAlias(db, "panel upgrade phase 2");
  assert.deepEqual(
    byNewName.map((p) => p.projectId),
    [project.projectId],
  );
});

test("explicit alias resolves case-insensitively", async () => {
  const db = await createTestDb();
  const project = await createProject(db, { name: "Substation Repair" });
  await addProjectAlias(db, project.projectId, "gardu induk");

  const matches = await resolveProjectsByNameOrAlias(db, "Gardu Induk");
  assert.deepEqual(
    matches.map((p) => p.projectId),
    [project.projectId],
  );
});

test("unrelated text resolves to no project", async () => {
  const db = await createTestDb();
  await createProject(db, { name: "Substation Repair" });
  assert.deepEqual(await resolveProjectsByNameOrAlias(db, "Nonexistent Project"), []);
});
