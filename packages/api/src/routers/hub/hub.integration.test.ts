import { beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import {
  createHubTestDb,
  seedHubAccount,
  seedProject,
  seedUser,
} from "@kan/hub/testing";

import { createHubCaller } from "./test-helpers";

// Each test boots an in-memory Postgres and applies every migration.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The back-office API on a real (in-memory) Postgres: who may call what, and
 * that the procedures reach the use cases.
 */

let db: dbClient;
let owner: { id: string; email: string };
let project: { publicId: string };

const callerFor = (
  user: { id: string; email: string } | null,
  headers: Record<string, string> = {},
) => createHubCaller(db, user, headers);

const withRole = async (
  email: string,
  role: "owner" | "admin" | "viewer" | null,
) => {
  const user = await seedUser(db, { email });
  if (role) await seedHubAccount(db, user.id, { role });
  return user;
};

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await withRole("owner@example.test", "owner");
  project = await seedProject(db, owner, { name: "CourseMate" });
});

describe("who may use the back office", () => {
  it("refuses a visitor who is not signed in", async () => {
    await expect(callerFor(null).overview()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses an ordinary member with FORBIDDEN, not a login redirect", async () => {
    const member = await withRole("member@example.test", null);
    await expect(callerFor(member).overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses API keys even for an owner", async () => {
    await expect(
      callerFor(owner, { "x-api-key": "anything" }).overview(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(owner, { authorization: "Bearer anything" }).overview(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a suspended owner", async () => {
    await seedHubAccount(db, owner.id, { status: "suspended" });
    await expect(callerFor(owner).overview()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lets a viewer read but not change anything", async () => {
    const viewer = await withRole("viewer@example.test", "viewer");
    const caller = callerFor(viewer);

    await expect(caller.overview()).resolves.toMatchObject({ projects: 1 });
    await expect(caller.accounts.list({ page: 1 })).resolves.toMatchObject({
      total: 2,
    });
    await expect(
      caller.accounts.create({
        name: "x",
        email: "x@example.test",
        hubRole: null,
        projects: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.audit.list({ page: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("hub.me", () => {
  it("tells anyone signed in their role, permissions, website and mailbox access", async () => {
    const member = await withRole("member@example.test", null);

    await expect(callerFor(member).me.get()).resolves.toEqual({
      userId: member.id,
      email: "member@example.test",
      role: null,
      permissions: [],
      siteAccess: null,
      mailAccess: false,
    });
    await expect(callerFor(owner).me.get()).resolves.toMatchObject({
      role: "owner",
      permissions: expect.arrayContaining(["admins.manage"]) as unknown,
    });
  });
});

describe("account management through the API", () => {
  it("creates an account, returns its temporary password once, and lists it", async () => {
    const admin = await withRole("admin@example.test", "admin");
    const caller = callerFor(admin);

    const created = await caller.accounts.create({
      name: "新成员",
      email: "new@example.test",
      hubRole: null,
      projects: [{ projectPublicId: project.publicId, role: "member" }],
    });
    expect(created.temporaryPassword).toHaveLength(16);

    const detail = await caller.accounts.get({ userId: created.userId });
    expect(detail).toMatchObject({
      email: "new@example.test",
      projects: [{ role: "member" }],
    });
    expect(JSON.stringify(detail)).not.toContain(created.temporaryPassword);
  });

  it("passes the use case's refusal through with its message", async () => {
    const admin = await withRole("admin@example.test", "admin");

    await expect(
      callerFor(admin).accounts.resetPassword({ userId: owner.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "只有所有者能管理后台成员的账号",
    });
  });

  it("only lets owners appoint back-office roles", async () => {
    const admin = await withRole("admin@example.test", "admin");
    const member = await withRole("member@example.test", null);

    await expect(
      callerFor(admin).accounts.setRole({ userId: member.id, role: "viewer" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(owner).accounts.setRole({ userId: member.id, role: "viewer" }),
    ).resolves.toBeUndefined();
  });
});

describe("registration links through the API", () => {
  it("issues a link token once, lists the grant without it, and revokes", async () => {
    const admin = await withRole("admin@example.test", "admin");
    const caller = callerFor(admin);

    const issued = await caller.grants.issue({
      email: "invitee@example.test",
      hubRole: null,
      note: null,
      projects: [{ projectPublicId: project.publicId, role: "guest" }],
    });
    expect(issued.token).toHaveLength(43);

    const page = await caller.grants.list({ page: 1 });
    expect(page.items[0]).toMatchObject({
      email: "invitee@example.test",
      state: "pending",
    });
    expect(JSON.stringify(page)).not.toContain(issued.token);

    await caller.grants.revoke({ grantPublicId: issued.publicId });
    expect((await caller.grants.list({ page: 1 })).items[0]?.state).toBe(
      "revoked",
    );
  });

  it("does not let an admin issue a link that appoints a back-office role", async () => {
    const admin = await withRole("admin@example.test", "admin");

    await expect(
      callerFor(admin).grants.issue({
        email: "boss@example.test",
        hubRole: "owner",
        note: null,
        projects: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("records everything in the audit log, readable by admins", async () => {
    const admin = await withRole("admin@example.test", "admin");
    const caller = callerFor(admin);
    await caller.grants.issue({
      email: "invitee@example.test",
      hubRole: null,
      note: null,
      projects: [],
    });

    const log = await caller.audit.list({ page: 1 });
    expect(log.items.map((e) => e.action)).toEqual(["grant.issued"]);
  });
});
