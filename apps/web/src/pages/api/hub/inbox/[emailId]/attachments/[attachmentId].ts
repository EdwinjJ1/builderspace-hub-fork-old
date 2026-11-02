import type { NextApiRequest, NextApiResponse } from "next";

import { getAccessFacts } from "@kan/hub/accounts";
import { connectInbox, openInboxAttachment } from "@kan/hub/inbox";

import {
  authenticateDocumentRequest,
  respondWithHubError,
} from "~/hub/server/documents-auth";
import { withHubRateLimit } from "~/hub/server/rate-limit";

/**
 * Opens one attachment of a mail in the club mailbox, for a signed-in person
 * with mailbox access: checks that, asks Resend for a fresh signed link and
 * redirects to it. Resend's links expire, so the page links here rather than
 * to Resend. The redirect is never cached: access can be taken away.
 */
export default withHubRateLimit(
  "inbox-attachment",
  { window: 60, max: 60 },
  async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).end();
      return;
    }

    const auth = await authenticateDocumentRequest(req, res);
    if (!auth) return;

    const inbox = connectInbox();
    if (!inbox) {
      res.status(503).json({ error: "还没有连接邮箱" });
      return;
    }

    try {
      const { mailAccess } = await getAccessFacts(auth.db, auth.actor.userId);
      const url = await openInboxAttachment(
        inbox,
        { userId: auth.actor.userId, mailAccess },
        // Checked as Resend ids there; a repeated parameter fails that check.
        {
          emailId: String(req.query.emailId),
          attachmentId: String(req.query.attachmentId),
        },
      );
      res.redirect(302, url);
    } catch (error) {
      respondWithHubError(res, error);
    }
  },
);
