import { z } from "zod";

import type { InboxAuthentication, InboxClient } from "./inbox.resend";
import { HubError } from "../shared/errors";
import {
  canReadMail,
  INBOX_PAGE_SIZE,
  isListedAttachment,
} from "./inbox.policy";

/**
 * Reading the club mailbox. Every use case checks the reader's mailbox access
 * itself, whatever the caller already checked.
 */

/** Someone reading the mailbox. */
export interface InboxActor {
  userId: string;
  mailAccess: boolean;
}

// Resend's ids are UUIDs; anything else never reaches it.
const mailId = z.string().uuid("邮件编号不对");

export const inboxInputs = {
  list: z.object({ after: mailId.optional() }),
  message: z.object({ emailId: mailId }),
  attachment: z.object({ emailId: mailId, attachmentId: mailId }),
};

export interface InboxListItem {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  receivedAt: Date;
  attachmentCount: number;
}

export interface InboxMessageView extends InboxListItem {
  cc: string[];
  replyTo: string[];
  html: string | null;
  text: string | null;
  authentication: InboxAuthentication | null;
  attachments: {
    id: string;
    filename: string | null;
    contentType: string;
    size: number;
  }[];
}

function requireMailAccess(actor: InboxActor): void {
  if (!canReadMail(actor.mailAccess)) {
    throw new HubError("FORBIDDEN", "没有查看邮箱的权限");
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HubError(
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "输入不正确",
    );
  }
  return parsed.data;
}

/** One page of received mail, newest first; `after` is the last id of the page before. */
export async function listInbox(
  inbox: InboxClient,
  actor: InboxActor,
  input: z.input<typeof inboxInputs.list>,
): Promise<{ items: InboxListItem[]; hasMore: boolean; pageSize: number }> {
  requireMailAccess(actor);
  const { after } = parseInput(inboxInputs.list, input);
  const page = await inbox.list({ limit: INBOX_PAGE_SIZE, after });
  return {
    items: page.items.map(({ attachments, ...mail }) => ({
      ...mail,
      attachmentCount: attachments.filter(isListedAttachment).length,
    })),
    hasMore: page.hasMore,
    pageSize: INBOX_PAGE_SIZE,
  };
}

/**
 * One mail with its body. The HTML is returned as the sender wrote it: the
 * page shows it only inside a sandboxed frame (`mailFrameDocument`).
 */
export async function getInboxMessage(
  inbox: InboxClient,
  actor: InboxActor,
  input: z.input<typeof inboxInputs.message>,
): Promise<InboxMessageView> {
  requireMailAccess(actor);
  const { emailId } = parseInput(inboxInputs.message, input);
  const {
    attachments,
    messageId: _messageId,
    ...mail
  } = await inbox.get(emailId);
  const listed = attachments.filter(isListedAttachment);
  return {
    ...mail,
    attachmentCount: listed.length,
    attachments: listed.map(({ id, filename, contentType, size }) => ({
      id,
      filename,
      contentType,
      size,
    })),
  };
}

/**
 * A fresh signed link to one attachment. Asked for at the moment someone
 * opens it, so the link has not expired and access is checked again.
 */
export async function openInboxAttachment(
  inbox: InboxClient,
  actor: InboxActor,
  input: z.input<typeof inboxInputs.attachment>,
): Promise<string> {
  requireMailAccess(actor);
  const { emailId, attachmentId } = parseInput(inboxInputs.attachment, input);
  const { url } = await inbox.attachmentUrl(emailId, attachmentId);
  if (!/^https:\/\//i.test(url)) {
    throw new HubError("UNAVAILABLE", "附件的下载地址不对");
  }
  return url;
}
