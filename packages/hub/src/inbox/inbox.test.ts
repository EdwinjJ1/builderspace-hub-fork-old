import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboxClient, InboxMessage } from "./inbox.resend";
import { inboxConfig } from "./inbox.config";
import {
  connectInbox,
  createResendInbox,
  overrideInboxForTests,
} from "./inbox.resend";
import {
  getInboxMessage,
  listInbox,
  openInboxAttachment,
} from "./inbox.service";

const MAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const FILE_ID = "3b1d0df1-4223-5839-887f-54eedd27b419";
const LOGO_ID = "2a0c9ce0-3112-4728-976e-47ddcd16a318";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fakeFetch = (...responses: Response[]) => {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  return fn;
};

const requestOf = (fn: ReturnType<typeof fakeFetch>, call = 0) => {
  const [url, init] = fn.mock.calls[call] ?? [];
  return { url: url as string, init: init ?? {} };
};

const attachments = [
  {
    id: LOGO_ID,
    filename: "logo.png",
    content_type: "image/png",
    content_disposition: "inline",
    content_id: "logo",
    size: 4096,
  },
  {
    id: FILE_ID,
    filename: "cv.pdf",
    content_type: "application/pdf",
    content_disposition: null,
    content_id: null,
    size: 13264,
  },
];

describe("inboxConfig", () => {
  it("is off without the mailbox's own key", () => {
    expect(inboxConfig({})).toBeNull();
    expect(inboxConfig({ HUB_RESEND_INBOX_API_KEY: "  " })).toBeNull();
    // The sending key is a different, Sending-access key.
    expect(inboxConfig({ HUB_RESEND_API_KEY: "re_send" })).toBeNull();
  });

  it("takes the key from the environment", () => {
    expect(inboxConfig({ HUB_RESEND_INBOX_API_KEY: " re_read " })).toEqual({
      apiKey: "re_read",
    });
  });
});

describe("connectInbox", () => {
  afterEach(() => overrideInboxForTests(null));

  it("is not connected while no key is set", () => {
    expect(connectInbox({})).toBeNull();
    expect(
      connectInbox({ HUB_RESEND_INBOX_API_KEY: "re_read" }),
    ).not.toBeNull();
  });

  it("uses the test double when one is set", () => {
    const fake = {} as InboxClient;
    overrideInboxForTests(fake);
    expect(connectInbox({})).toBe(fake);
  });
});

describe("createResendInbox", () => {
  const config = { apiKey: "re_read" };

  it("lists a page of received mail with the key and a User-Agent", async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        object: "list",
        has_more: true,
        data: [
          {
            id: MAIL_ID,
            to: ["hello@builderspace.dev"],
            from: "Ada <ada@example.org>",
            created_at: "2026-10-09T14:37:40.951Z",
            subject: "Hi",
            bcc: [],
            cc: null,
            reply_to: [],
            message_id: "<1@example.org>",
            attachments,
          },
        ],
      }),
    );
    const inbox = createResendInbox(config, fetchImpl);

    const page = await inbox.list({ limit: 25, after: LOGO_ID });

    const { url, init } = requestOf(fetchImpl);
    expect(url).toBe(
      `https://api.resend.com/emails/receiving?limit=25&after=${LOGO_ID}`,
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_read",
      "User-Agent": "builderspace-hub",
    });
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({
      id: MAIL_ID,
      from: "Ada <ada@example.org>",
      to: ["hello@builderspace.dev"],
      subject: "Hi",
      receivedAt: new Date("2026-10-09T14:37:40.951Z"),
    });
    expect(page.items[0]?.attachments[1]).toEqual({
      id: FILE_ID,
      filename: "cv.pdf",
      contentType: "application/pdf",
      contentDisposition: null,
      contentId: null,
      size: 13264,
    });
  });

  it("reads one mail with its body and the sender's verdict", async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        object: "email",
        id: MAIL_ID,
        to: ["hello@builderspace.dev"],
        from: "ada@example.org",
        created_at: "2026-04-03T22:13:42.674Z",
        subject: null,
        html: "<p>Hi</p>",
        text: null,
        cc: ["bo@example.org"],
        reply_to: ["ada+reply@example.org"],
        message_id: "<1@example.org>",
        authentication: { spf: "pass", dkim: "fail", dmarc: null },
        attachments: [],
      }),
    );

    const mail = await createResendInbox(config, fetchImpl).get(MAIL_ID);

    expect(requestOf(fetchImpl).url).toBe(
      `https://api.resend.com/emails/receiving/${MAIL_ID}`,
    );
    expect(mail).toEqual({
      id: MAIL_ID,
      from: "ada@example.org",
      to: ["hello@builderspace.dev"],
      cc: ["bo@example.org"],
      replyTo: ["ada+reply@example.org"],
      subject: null,
      receivedAt: new Date("2026-04-03T22:13:42.674Z"),
      messageId: "<1@example.org>",
      html: "<p>Hi</p>",
      text: null,
      authentication: { spf: "pass", dkim: "fail", dmarc: "unknown" },
      attachments: [],
    } satisfies InboxMessage);
  });

  it("returns no verdict for mail received before Resend recorded one", async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        id: MAIL_ID,
        from: "ada@example.org",
        created_at: "2026-04-03T22:13:42.674Z",
      }),
    );
    const mail = await createResendInbox(config, fetchImpl).get(MAIL_ID);
    expect(mail).toMatchObject({
      to: [],
      cc: [],
      html: null,
      authentication: null,
    });
  });

  it("asks for one attachment's signed link", async () => {
    const fetchImpl = fakeFetch(
      jsonResponse(200, {
        object: "attachment",
        id: FILE_ID,
        download_url: "https://inbound-cdn.resend.com/x?signature=1",
        expires_at: "2026-10-17T14:29:41.521Z",
      }),
    );
    const link = await createResendInbox(config, fetchImpl).attachmentUrl(
      MAIL_ID,
      FILE_ID,
    );
    expect(requestOf(fetchImpl).url).toBe(
      `https://api.resend.com/emails/receiving/${MAIL_ID}/attachments/${FILE_ID}`,
    );
    expect(link).toEqual({
      url: "https://inbound-cdn.resend.com/x?signature=1",
      expiresAt: new Date("2026-10-17T14:29:41.521Z"),
    });
  });

  it.each([
    [404, { name: "not_found" }, "NOT_FOUND", "找不到这封信"],
    [403, { name: "email_above_quota" }, "UNAVAILABLE", "额度已满"],
    [401, { name: "restricted_api_key" }, "UNAVAILABLE", "Full access"],
    [403, { name: "invalid_api_key" }, "UNAVAILABLE", "Full access"],
    [429, { name: "rate_limit_exceeded" }, "UNAVAILABLE", "太频繁"],
    [422, { name: "invalid_parameter" }, "INVALID_INPUT", "编号不对"],
    [500, "not json", "UNAVAILABLE", "暂时出错"],
  ])(
    "turns HTTP %i into a plain sentence",
    async (status, body, code, words) => {
      const inbox = createResendInbox(
        config,
        fakeFetch(jsonResponse(status, body)),
      );
      const failure = inbox.get(MAIL_ID);
      await expect(failure).rejects.toMatchObject({ code });
      await expect(failure).rejects.toThrow(words);
      await expect(failure).rejects.not.toThrow("re_read");
    },
  );

  it("says so when Resend does not answer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("down"));
    await expect(
      createResendInbox(config, fetchImpl).list({ limit: 25 }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("refuses an answer of the wrong shape", async () => {
    const inbox = createResendInbox(
      config,
      fakeFetch(jsonResponse(200, { data: "nope" })),
    );
    await expect(inbox.list({ limit: 25 })).rejects.toThrow("看不懂");
  });
});

describe("mailbox use cases", () => {
  const reader = { userId: "u-1", mailAccess: true };
  const stranger = { userId: "u-2", mailAccess: false };

  const summary = {
    id: MAIL_ID,
    from: "ada@example.org",
    to: ["hello@builderspace.dev"],
    subject: "Hi",
    receivedAt: new Date("2026-10-09T14:37:40.951Z"),
    attachments: [
      {
        id: LOGO_ID,
        filename: "logo.png",
        contentType: "image/png",
        contentDisposition: "inline",
        contentId: "logo",
        size: 4096,
      },
      {
        id: FILE_ID,
        filename: "cv.pdf",
        contentType: "application/pdf",
        contentDisposition: null,
        contentId: null,
        size: 13264,
      },
    ],
  };
  const fakeInbox = () => ({
    list: vi.fn(() => Promise.resolve({ items: [summary], hasMore: false })),
    get: vi.fn(() =>
      Promise.resolve({
        ...summary,
        cc: [],
        replyTo: [],
        messageId: "<1@example.org>",
        html: "<p>Hi</p>",
        text: "Hi",
        authentication: null,
      }),
    ),
    attachmentUrl: vi.fn(() =>
      Promise.resolve({
        url: "https://inbound-cdn.resend.com/x",
        expiresAt: new Date(),
      }),
    ),
  });

  it("refuses everyone without mailbox access, before asking Resend", async () => {
    const inbox = fakeInbox();
    await expect(listInbox(inbox, stranger, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      getInboxMessage(inbox, stranger, { emailId: MAIL_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      openInboxAttachment(inbox, stranger, {
        emailId: MAIL_ID,
        attachmentId: FILE_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inbox.list).not.toHaveBeenCalled();
    expect(inbox.get).not.toHaveBeenCalled();
    expect(inbox.attachmentUrl).not.toHaveBeenCalled();
  });

  it("lists a page, counting only real attachments", async () => {
    const inbox = fakeInbox();
    const page = await listInbox(inbox, reader, { after: LOGO_ID });
    expect(inbox.list).toHaveBeenCalledWith({ limit: 25, after: LOGO_ID });
    expect(page).toEqual({
      items: [
        {
          id: MAIL_ID,
          from: "ada@example.org",
          to: ["hello@builderspace.dev"],
          subject: "Hi",
          receivedAt: summary.receivedAt,
          attachmentCount: 1,
        },
      ],
      hasMore: false,
      pageSize: 25,
    });
  });

  it("returns one mail with its listed attachments", async () => {
    const mail = await getInboxMessage(fakeInbox(), reader, {
      emailId: MAIL_ID,
    });
    expect(mail).toMatchObject({ html: "<p>Hi</p>", attachmentCount: 1 });
    expect(mail.attachments).toEqual([
      {
        id: FILE_ID,
        filename: "cv.pdf",
        contentType: "application/pdf",
        size: 13264,
      },
    ]);
    expect(mail).not.toHaveProperty("messageId");
  });

  it("refuses ids that are not Resend's, without asking it", async () => {
    const inbox = fakeInbox();
    await expect(
      getInboxMessage(inbox, reader, { emailId: "../api-keys" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listInbox(inbox, reader, { after: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(inbox.get).not.toHaveBeenCalled();
    expect(inbox.list).not.toHaveBeenCalled();
  });

  it("hands out an attachment's https link only", async () => {
    const ids = { emailId: MAIL_ID, attachmentId: FILE_ID };
    await expect(openInboxAttachment(fakeInbox(), reader, ids)).resolves.toBe(
      "https://inbound-cdn.resend.com/x",
    );
    const odd = fakeInbox();
    odd.attachmentUrl.mockResolvedValueOnce({
      url: "javascript:alert(1)",
      expiresAt: new Date(),
    });
    await expect(openInboxAttachment(odd, reader, ids)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
