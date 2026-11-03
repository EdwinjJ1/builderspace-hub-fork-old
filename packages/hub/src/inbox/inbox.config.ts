/**
 * Where the mailbox's settings come from. Server only.
 *
 * Reading received mail needs a Resend key with Full access; the key the Hub
 * sends with (`HUB_RESEND_API_KEY`) should stay Sending access only, so the
 * mailbox has a key of its own. Reading does not count against Resend's
 * sending quota.
 */
export interface InboxConfig {
  apiKey: string;
}

/** The mailbox's settings, or null while no key is set (the page says so). */
export function inboxConfig(
  env: Record<string, string | undefined> = process.env,
): InboxConfig | null {
  const apiKey = env.HUB_RESEND_INBOX_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}
