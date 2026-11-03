/**
 * The club mailbox (hello@builderspace.dev, read from Resend): who may read
 * it, and how a mail's HTML is shown. Pure: shared by the server, which
 * enforces access, and the browser, which builds the mail's frame.
 *
 * Mailbox access is granted per person by an owner and has nothing to do with
 * the back-office role or website access: an owner without it cannot read the
 * mail either.
 */

/** The single mailbox permission check. */
export function canReadMail(mailAccess: boolean | null | undefined): boolean {
  return mailAccess === true;
}

/** Mails per page of the list; Resend allows up to 100. */
export const INBOX_PAGE_SIZE = 25;

/**
 * The `sandbox` of the frame a mail's HTML is shown in. No `allow-scripts` and
 * no `allow-same-origin`: the mail cannot run code and is treated as coming
 * from nowhere, so it cannot touch this app's cookies, storage or API. Popups
 * are allowed only so that links open in a new tab (outside the sandbox, as
 * an ordinary page).
 */
export const MAIL_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/**
 * What the mail may load. Nothing from the network except, once someone asks
 * for them, images: remote images tell the sender the mail was opened (and
 * from where), so they stay off by default. Inline images arrive as `data:`
 * URIs and always show.
 */
export function mailFrameCsp(options: { remoteImages: boolean }): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${options.remoteImages ? " https: http:" : ""}`,
    "font-src data:",
    "media-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * Whether the mail asks for images from the network, so that the page only
 * offers to load them when there are some. A rough look is enough: the CSP,
 * not this, is what blocks them.
 */
export function hasRemoteImages(html: string): boolean {
  return /\b(?:src|background|srcset)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i.test(
    html,
  );
}

/** `<meta http-equiv="refresh">` would send the frame to another page. */
const META_REFRESH = /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi;

/**
 * The document a mail's HTML is shown as, for the frame's `srcdoc`. Our CSP
 * comes first, so it applies to everything after it; a policy inside the mail
 * can only narrow it further. Links open in a new tab without a referrer.
 */
export function mailFrameDocument(
  html: string,
  options: { remoteImages: boolean },
): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${mailFrameCsp(options)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<base target="_blank">',
    "<style>body{margin:0;padding:16px;background:#fff;color:#111;",
    "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
    "overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>",
    "</head><body>",
    html.replace(META_REFRESH, ""),
    "</body></html>",
  ].join("");
}

/** A mail address as written in a header: `Name <address>` or just the address. */
export function splitAddress(raw: string): {
  name: string | null;
  address: string;
} {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  if (!match) return { name: null, address: raw.trim() };
  const name = match[1]?.trim() ?? "";
  return {
    name: name.length > 0 ? name : null,
    address: match[2]?.trim() ?? "",
  };
}

/**
 * Whether an attachment is one to list. An inline image with a content id is
 * part of the mail's body (a logo in a signature) and already shows there.
 */
export function isListedAttachment(attachment: {
  contentDisposition: string | null;
  contentId: string | null;
}): boolean {
  return !(attachment.contentDisposition === "inline" && attachment.contentId);
}

/** Where the browser opens one attachment: a Hub route that checks access, then redirects. */
export function inboxAttachmentHref(
  emailId: string,
  attachmentId: string,
): string {
  return `/api/hub/inbox/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
