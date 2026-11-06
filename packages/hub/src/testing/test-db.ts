import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { pgliteExtensions } from "@kan/db/client";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import * as kanSchema from "@kan/db/schema";

import type { Db } from "../db";
import type { AccountStatus, HubRole } from "../schema";
import type { SiteAccess } from "../site/site.policy";
import { upsertAccount } from "../accounts/account.repo";
import {
  HUB_MIGRATIONS_SCHEMA,
  HUB_MIGRATIONS_TABLE,
} from "../migration-table";
import { hubMigrationsFolder, kanMigrationsFolder } from "../migrations-path";

/** Applies Kan's migrations, then the Hub's, exactly as a deployment does. */
export async function applyAllMigrations(db: Db): Promise<void> {
  // The PGlite migrator only needs the query interface both clients share.
  const target = db as unknown as Parameters<typeof migrate>[0];

  await migrate(target, { migrationsFolder: kanMigrationsFolder });
  await migrate(target, {
    migrationsFolder: hubMigrationsFolder,
    migrationsTable: HUB_MIGRATIONS_TABLE,
    migrationsSchema: HUB_MIGRATIONS_SCHEMA,
  });
}

const createEmptyDb = (): Db => {
  const client = new PGlite({ extensions: pgliteExtensions });
  return drizzle(client, { schema: kanSchema }) as unknown as Db;
};

/**
 * A fresh in-memory Postgres with every migration applied. Each call is an
 * isolated database, so tests never share state.
 */
export async function createHubTestDb(): Promise<Db> {
  const db = createEmptyDb();
  await applyAllMigrations(db);
  return db;
}

/** A database where Kan is installed but the Hub's migrations never ran. */
export async function createKanOnlyTestDb(): Promise<Db> {
  const db = createEmptyDb();
  const target = db as unknown as Parameters<typeof migrate>[0];
  await migrate(target, { migrationsFolder: kanMigrationsFolder });
  return db;
}

let userCounter = 0;

/** Inserts a Kan user the way Better Auth would (lower-cased e-mail). */
export async function seedUser(
  db: Db,
  overrides: { email?: string; name?: string } = {},
): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = (
    overrides.email ?? `user${userCounter}@example.test`
  ).toLowerCase();

  const [user] = await db
    .insert(kanSchema.users)
    .values({
      name: overrides.name ?? `User ${userCounter}`,
      email,
      emailVerified: false,
    })
    .returning({ id: kanSchema.users.id, email: kanSchema.users.email });

  if (!user) throw new Error("seedUser: insert returned no row");
  return user;
}

let workspaceCounter = 0;

/**
 * Creates a project through Kan's own repository, so it gets the system roles
 * and the creator's admin membership a real workspace has.
 */
export async function seedProject(
  db: Db,
  owner: { id: string; email: string },
  overrides: { name?: string; slug?: string } = {},
): Promise<{ id: number; publicId: string; name: string }> {
  workspaceCounter += 1;
  const created = await workspaceRepo.create(db, {
    name: overrides.name ?? `Project ${workspaceCounter}`,
    slug: overrides.slug ?? `project-${workspaceCounter}`,
    createdBy: owner.id,
    createdByEmail: owner.email,
  });

  const publicId = created.publicId;
  if (!publicId) throw new Error("seedProject: workspace was not created");

  const row = await workspaceRepo.getByPublicId(db, publicId);
  if (!row) throw new Error("seedProject: workspace not found after insert");

  return { id: row.id, publicId: row.publicId, name: row.name };
}

/** Gives a seeded user a back-office role and/or status. */
export async function seedHubAccount(
  db: Db,
  userId: string,
  facts: {
    role?: HubRole | null;
    siteAccess?: SiteAccess | null;
    mailAccess?: boolean;
    status?: AccountStatus;
  },
): Promise<void> {
  await upsertAccount(db, userId, { ...facts, now: new Date() });
}

export { overrideSiteDbForTests } from "../site/site.db";
export { overrideInboxForTests } from "../inbox/inbox.resend";
export {
  createSiteTestDb,
  seedSiteJoin,
  seedSiteProject,
  seedSiteUpdate,
  seedSiteVolunteer,
} from "./site-test-db";

export { MemoryDocumentStorage } from "./memory-storage";
