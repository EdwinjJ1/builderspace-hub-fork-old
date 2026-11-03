import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { dbClient } from "@kan/db/client";
import type { InboxClient } from "@kan/hub/inbox";
import {
  createHubTestDb,
  overrideInboxForTests,
  seedHubAccount,
  seedUser,
} from "@kan/hub/testing";

import { createHubCaller } from "./test-helpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The mailbox page's API: closed until an owner grants mailbox access, the
 * owner-only switch, and the refusal while no Resend key is set. Resend is a
 * fake here; the client and use cases are tested in @kan/hub.
 */

const MAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

let db: dbClient;
let owner: { id: string; email: string };
let list: ReturnType<typeof vi.fn<InboxClient["list"]>>;

const userWith = async (
  email: string,
  facts: Parameters<typeof seedHubAccount>[2],
) => {
  const user = await seedUser(db, { email });
  await seedHubAccount(db, user.id, facts);
  return user;
};

const mail = {
  id: MAIL_ID,
  from: "Ada <ada@example.org>",
  to: ["hello@builderspace.dev"],
  subject: "Hi",
  receivedAt: new Date("2026-10-09T14:37:40.951Z"),
  attachments: [],
};

beforeEach(async () => {
  db = await createHubTestDb();
  owner = await userWith("owner@example.test", { role: "owner" });
  list = vi.fn(() => Promise.resolve({ items: [mail], hasMore: false }));
  overrideInboxForTests({
    list,
    get: vi.fn(() =>
      Promise.resolve({
        ...mail,
        cc: [],
        replyTo: [],
        messageId: null,
        html: "<p>Hi</p>",
        text: null,
        authentication: null,
      }),
    ),
    attachmentUrl: vi.fn(),
  });
});

afterEach(() => {
  overrideInboxForTests(null);
  vi.unstubAllEnvs();
});

describe("hub.inbox", () => {
  it("is closed to an owner until mailbox access is granted", async () => {
    const caller = createHubCaller(db, owner);
    expect(await caller.me.get()).toMatchObject({ mailAccess: false });
    expect(await caller.inbox.status()).toEqual({
      access: false,
      connected: false,
    });
    await expect(caller.inbox.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.inbox.message({ emailId: MAIL_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(list).not.toHaveBeenCalled();

    await caller.accounts.setMailAccess({ userId: owner.id, access: true });

    expect(await caller.me.get()).toMatchObject({ mailAccess: true });
    expect(await caller.inbox.status()).toEqual({
      access: true,
      connected: true,
    });
    await expect(caller.inbox.list({})).resolves.toMatchObject({
      items: [{ id: MAIL_ID, attachmentCount: 0 }],
      hasMore: false,
    });
    await expect(
      caller.inbox.message({ emailId: MAIL_ID }),
    ).resolves.toMatchObject({ html: "<p>Hi</p>" });
  });

  it("is separate from website access", async () => {
    const operator = await userWith("ops@example.test", {
      role: "admin",
      siteAccess: "manage",
    });
    await expect(
      createHubCaller(db, operator).inbox.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const reader = await userWith("reader@example.test", { mailAccess: true });
    const caller = createHubCaller(db, reader);
    await expect(caller.inbox.list({})).resolves.toMatchObject({
      pageSize: 25,
    });
    await expect(caller.site.summary()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lets only owners grant mailbox access", async () => {
    const admin = await userWith("admin@example.test", { role: "admin" });
    await expect(
      createHubCaller(db, admin).accounts.setMailAccess({
        userId: admin.id,
        access: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a suspended account even with mailbox access", async () => {
    const reader = await userWith("reader@example.test", {
      mailAccess: true,
      status: "suspended",
    });
    await expect(
      createHubCaller(db, reader).inbox.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an API key: the mailbox is for the web app only", async () => {
    const reader = await userWith("reader@example.test", { mailAccess: true });
    await expect(
      createHubCaller(db, reader, { "x-api-key": "k" }).inbox.list({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("says when no Resend key is set", async () => {
    overrideInboxForTests(null);
    vi.stubEnv("HUB_RESEND_INBOX_API_KEY", "");
    const reader = await userWith("reader@example.test", { mailAccess: true });
    const caller = createHubCaller(db, reader);

    expect(await caller.inbox.status()).toEqual({
      access: true,
      connected: false,
    });
    await expect(caller.inbox.list({})).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "还没有连接邮箱",
    });
  });
});
