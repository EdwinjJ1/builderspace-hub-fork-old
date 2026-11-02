import { z } from "zod";

import type { InboxConfig } from "./inbox.config";
import { HubError } from "../shared/errors";
import { inboxConfig } from "./inbox.config";

/**
 * Reads received mail from Resend's API (`/emails/receiving`). Server only.
 * Nothing is stored in the Hub: Resend keeps received mail for 30 days, and
 * every page asks it again.
 */

export interface InboxAttachment {
  id: string;
  filename: string | null;
  contentType: string;
  contentDisposition: string | null;
  contentId: string | null;
  size: number;
}

export interface InboxSummary {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  receivedAt: Date;
  attachments: InboxAttachment[];
}

/** Resend's verdict on the sender, from the receiving server (cannot be forged by the sender). */
export interface InboxAuthentication {
  spf: string;
  dkim: string;
  dmarc: string;
}

export interface InboxMessage extends InboxSummary {
  cc: string[];
  replyTo: string[];
  messageId: string | null;
  /** Inline images are `data:` URIs. */
  html: string | null;
  text: string | null;
  authentication: InboxAuthentication | null;
}

export interface InboxPageRequest {
  limit: number;
  /** The id of the last mail of the previous page: returns older mail. */
  after?: string;
}

export interface InboxClient {
  list(request: InboxPageRequest): Promise<{
    items: InboxSummary[];
    hasMore: boolean;
  }>;
  get(emailId: string): Promise<InboxMessage>;
  /** A signed link to one attachment's file; it expires after a while. */
  attachmentUrl(
    emailId: string,
    attachmentId: string,
  ): Promise<{ url: string; expiresAt: Date }>;
}

const API = "https://api.resend.com/emails/receiving";
const TIMEOUT_MS = 10_000;

const addresses = z
  .array(z.string())
  .nullish()
  .transform((list) => list ?? []);

const attachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string().nullish(),
    content_type: z.string().nullish(),
    content_disposition: z.string().nullish(),
    content_id: z.string().nullish(),
    size: z.number().nullish(),
  })
  .transform(
    (a): InboxAttachment => ({
      id: a.id,
      filename: a.filename ?? null,
      contentType: a.content_type ?? "application/octet-stream",
      contentDisposition: a.content_disposition ?? null,
      contentId: a.content_id ?? null,
      size: a.size ?? 0,
    }),
  );

const summaryFields = {
  id: z.string(),
  from: z.string().nullish(),
  to: addresses,
  subject: z.string().nullish(),
  created_at: z.string(),
  attachments: z
    .array(attachmentSchema)
    .nullish()
    .transform((list) => list ?? []),
};

const toSummary = (mail: {
  id: string;
  from?: string | null;
  to: string[];
  subject?: string | null;
  created_at: string;
  attachments: InboxAttachment[];
}): InboxSummary => ({
  id: mail.id,
  from: mail.from ?? "",
  to: mail.to,
  subject: mail.subject ?? null,
  receivedAt: new Date(mail.created_at),
  attachments: mail.attachments,
});

const listSchema = z.object({
  has_more: z.boolean().nullish(),
  data: z.array(z.object(summaryFields)),
});

const verdict = z.string().nullish();
const messageSchema = z.object({
  ...summaryFields,
  cc: addresses,
  reply_to: addresses,
  message_id: z.string().nullish(),
  html: z.string().nullish(),
  text: z.string().nullish(),
  authentication: z
    .object({ spf: verdict, dkim: verdict, dmarc: verdict })
    .nullish(),
});

const attachmentLinkSchema = z.object({
  download_url: z.string().url(),
  expires_at: z.string(),
});

/** Resend's own name for a refusal (`not_found`, `restricted_api_key`…), if the body has one. */
async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body.name === "string" ? body.name : null;
  } catch {
    return null;
  }
}

/** One plain sentence for the page; the key and the mail never appear in it. */
async function refusal(response: Response): Promise<HubError> {
  const name = await errorName(response);
  if (response.status === 404 || name === "not_found") {
    return new HubError(
      "NOT_FOUND",
      "找不到这封信，可能已经超过 30 天被删除了",
    );
  }
  if (name === "email_above_quota") {
    return new HubError(
      "UNAVAILABLE",
      "这封信收到时 Resend 的额度已满，看不到正文",
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new HubError(
      "UNAVAILABLE",
      "邮箱的 Resend key 无效或权限不够（需要 Full access），请联系所有者",
    );
  }
  if (response.status === 429) {
    return new HubError("UNAVAILABLE", "Resend 那边请求太频繁，请稍后再试");
  }
  if (response.status === 422) {
    return new HubError("INVALID_INPUT", "邮件编号不对");
  }
  return new HubError("UNAVAILABLE", "邮箱服务暂时出错，请稍后再试");
}

export function createResendInbox(
  config: InboxConfig,
  fetchImpl: typeof fetch = fetch,
): InboxClient {
  async function read<T>(
    url: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          // Resend turns away requests without one.
          "User-Agent": "builderspace-hub",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HubError("UNAVAILABLE", "邮箱服务没有回应，请稍后再试");
    }
    if (!response.ok) throw await refusal(response);

    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new HubError("UNAVAILABLE", "邮箱服务返回的内容看不懂");
    }
    return parsed.data;
  }

  const mailUrl = (emailId: string) => `${API}/${encodeURIComponent(emailId)}`;

  return {
    async list({ limit, after }) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (after) query.set("after", after);
      const body = await read(`${API}?${query.toString()}`, listSchema);
      return {
        items: body.data.map(toSummary),
        hasMore: body.has_more ?? false,
      };
    },

    async get(emailId) {
      const mail = await read(mailUrl(emailId), messageSchema);
      const auth = mail.authentication;
      return {
        ...toSummary(mail),
        cc: mail.cc,
        replyTo: mail.reply_to,
        messageId: mail.message_id ?? null,
        html: mail.html ?? null,
        text: mail.text ?? null,
        authentication: auth
          ? {
              spf: auth.spf ?? "unknown",
              dkim: auth.dkim ?? "unknown",
              dmarc: auth.dmarc ?? "unknown",
            }
          : null,
      };
    },

    async attachmentUrl(emailId, attachmentId) {
      const link = await read(
        `${mailUrl(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
        attachmentLinkSchema,
      );
      return { url: link.download_url, expiresAt: new Date(link.expires_at) };
    },
  };
}

let override: InboxClient | null = null;

/** The mailbox for this deployment, or null while no key is set. */
export function connectInbox(
  env: Record<string, string | undefined> = process.env,
): InboxClient | null {
  if (override) return override;
  const config = inboxConfig(env);
  return config ? createResendInbox(config) : null;
}

/** Tests replace Resend with a fake; `null` restores the real one. */
export function overrideInboxForTests(client: InboxClient | null): void {
  override = client;
}
