import {
  canReadMail,
  connectInbox,
  getInboxMessage,
  inboxInputs,
  listInbox,
} from "@kan/hub/inbox";

import { createTRPCRouter } from "../../trpc";
import { hubInboxProcedure, hubProcedure, runHub } from "./procedures";

/**
 * `hub.inbox.*`: the 官网 section's mailbox page, over Resend's received mail
 * for hello@builderspace.dev. Read only. Attachments open through
 * `/api/hub/inbox/…`, which checks the same access.
 */
export const inboxRouter = createTRPCRouter({
  /** My mailbox access, and whether a Resend key is set. */
  status: hubProcedure.query(({ ctx }) => ({
    access: ctx.mailAccess,
    connected: canReadMail(ctx.mailAccess) && connectInbox() !== null,
  })),

  list: hubInboxProcedure
    .input(inboxInputs.list)
    .query(({ ctx, input }) =>
      runHub(() => listInbox(ctx.inbox, ctx.inboxActor, input)),
    ),

  message: hubInboxProcedure
    .input(inboxInputs.message)
    .query(({ ctx, input }) =>
      runHub(() => getInboxMessage(ctx.inbox, ctx.inboxActor, input)),
    ),
});
