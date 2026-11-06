import { describe, expect, it } from "vitest";

import {
  canReadMail,
  hasRemoteImages,
  inboxAttachmentHref,
  isListedAttachment,
  MAIL_FRAME_SANDBOX,
  mailFrameCsp,
  mailFrameDocument,
  splitAddress,
} from "./inbox.policy";

describe("canReadMail", () => {
  it("needs access granted explicitly", () => {
    expect(canReadMail(true)).toBe(true);
    expect(canReadMail(false)).toBe(false);
    expect(canReadMail(null)).toBe(false);
    expect(canReadMail(undefined)).toBe(false);
  });
});

describe("the mail frame", () => {
  it("lets no script run and gives the mail no origin of ours", () => {
    const flags = MAIL_FRAME_SANDBOX.split(/\s+/);
    expect(flags).not.toContain("allow-scripts");
    expect(flags).not.toContain("allow-same-origin");
    expect(flags).not.toContain("allow-top-navigation");
    expect(flags).not.toContain("allow-forms");
    expect(flags).toContain("allow-popups-to-escape-sandbox");
  });

  it("blocks scripts, frames, forms and remote loads by default", () => {
    const csp = mailFrameCsp({ remoteImages: false });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("img-src data:;");
    expect(csp).not.toContain("https:");
  });

  it("loads remote images only when asked", () => {
    expect(mailFrameCsp({ remoteImages: true })).toContain(
      "img-src data: https: http:",
    );
  });

  it("puts the policy ahead of the mail, whatever the mail starts with", () => {
    const mail =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><script>alert(1)</script>hi</body></html>';
    const doc = mailFrameDocument(mail, { remoteImages: false });
    const ours = doc.indexOf(mailFrameCsp({ remoteImages: false }));
    expect(ours).toBeGreaterThan(-1);
    expect(ours).toBeLessThan(doc.indexOf(mail));
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("drops a meta refresh, which would send the frame elsewhere", () => {
    const doc = mailFrameDocument(
      `<META HTTP-EQUIV="refresh" content="0;url=https://evil.example">hello <meta http-equiv=refresh content=1>`,
      { remoteImages: false },
    );
    expect(doc).not.toMatch(/refresh/i);
    expect(doc).toContain("hello");
  });
});

describe("splitAddress", () => {
  it("splits a display name from the address", () => {
    expect(splitAddress("Ada Lovelace <ada@example.org>")).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.org",
    });
    expect(splitAddress('"Lee, Bo" <bo@example.org>')).toEqual({
      name: "Lee, Bo",
      address: "bo@example.org",
    });
  });

  it("keeps a bare address as is", () => {
    expect(splitAddress(" ada@example.org ")).toEqual({
      name: null,
      address: "ada@example.org",
    });
    expect(splitAddress("<ada@example.org>")).toEqual({
      name: null,
      address: "ada@example.org",
    });
  });
});

describe("isListedAttachment", () => {
  it("leaves out inline images the body already shows", () => {
    expect(
      isListedAttachment({ contentDisposition: "inline", contentId: "logo" }),
    ).toBe(false);
    expect(
      isListedAttachment({ contentDisposition: "inline", contentId: null }),
    ).toBe(true);
    expect(
      isListedAttachment({ contentDisposition: "attachment", contentId: "x" }),
    ).toBe(true);
    expect(
      isListedAttachment({ contentDisposition: null, contentId: null }),
    ).toBe(true);
  });
});

describe("inboxAttachmentHref", () => {
  it("points at the Hub's own route, never at Resend", () => {
    expect(inboxAttachmentHref("e-1", "a/1")).toBe(
      "/api/hub/inbox/e-1/attachments/a%2F1",
    );
  });
});

describe("hasRemoteImages", () => {
  it("spots images and backgrounds from the network", () => {
    expect(hasRemoteImages('<img src="https://t.example/p.gif">')).toBe(true);
    expect(hasRemoteImages("<img src=//t.example/p.gif>")).toBe(true);
    expect(hasRemoteImages('<td background="http://x.example/a.png">')).toBe(
      true,
    );
    expect(
      hasRemoteImages("<div style=\"background:url('https://x.example/a')\">"),
    ).toBe(true);
  });

  it("ignores inline images and plain links", () => {
    expect(hasRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(
      false,
    );
    expect(hasRemoteImages('<a href="https://example.org">deck</a>')).toBe(
      false,
    );
  });
});
