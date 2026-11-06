import { z } from "zod";

import {
  createFolder,
  createTextDocument,
  decideEditRequest,
  deleteDocument,
  deleteFolder,
  findEditorCandidates,
  getAudienceOptions,
  getDocumentDetail,
  getDocumentStorage,
  getLibrary,
  grantEditor,
  listDecidableRequests,
  readTextContent,
  renameFolder,
  replaceTextContent,
  requestEdit,
  revokeEditor,
  updateDocument,
} from "@kan/hub/documents";

import { createTRPCRouter } from "../../trpc";
import { hubProcedure, runHub } from "./procedures";

/**
 * The document library, mounted at `hub.documents.*`. Every procedure is open
 * to any signed-in member; what each person may actually do (read, write,
 * change, hand out edit rights) is decided inside the use cases, which are the
 * single place those rules live. No input carries a secret.
 */

const id = z.string().min(1).max(32);
const documentInput = z.object({ documentPublicId: id });
const userInput = documentInput.extend({ userId: z.string().uuid() });

/** Who can read a document; checked in full by the use case. */
const audienceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("editors") }),
  z.object({
    kind: z.literal("selected"),
    userIds: z.array(z.string().max(64)).max(500),
    groups: z
      .array(
        z.object({ projectPublicId: id, departmentPublicId: id.nullable() }),
      )
      .max(200),
  }),
]);

export const documentsRouter = createTRPCRouter({
  /** A folder's contents (or the top level), or search results. */
  library: hubProcedure
    .input(
      z.object({
        folderPublicId: id.nullish(),
        search: z.string().max(100).nullish(),
      }),
    )
    .query(({ ctx, input }) =>
      runHub(() =>
        getLibrary(ctx.db, getDocumentStorage(ctx.db), ctx.actor, input),
      ),
    ),

  get: hubProcedure
    .input(documentInput)
    .query(({ ctx, input }) =>
      runHub(() =>
        getDocumentDetail(
          ctx.db,
          getDocumentStorage(ctx.db),
          ctx.actor,
          input.documentPublicId,
        ),
      ),
    ),

  createFolder: hubProcedure
    .input(
      z.object({ name: z.string().max(200), parentPublicId: id.nullish() }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => createFolder(ctx.db, ctx.actor, input)),
    ),

  renameFolder: hubProcedure
    .input(z.object({ folderPublicId: id, name: z.string().max(200) }))
    .mutation(({ ctx, input }) =>
      runHub(() => renameFolder(ctx.db, ctx.actor, input)),
    ),

  deleteFolder: hubProcedure
    .input(z.object({ folderPublicId: id }))
    .mutation(({ ctx, input }) =>
      runHub(() => deleteFolder(ctx.db, ctx.actor, input.folderPublicId)),
    ),

  /** Writes a document (Markdown or HTML) in the page. */
  createText: hubProcedure
    .input(
      z.object({
        title: z.string().max(300),
        filename: z.string().min(1).max(300),
        content: z.string().max(410_000),
        description: z.string().max(2000).nullish(),
        folderPublicId: id.nullish(),
        audience: audienceInput.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() =>
        createTextDocument(
          ctx.db,
          getDocumentStorage(ctx.db),
          ctx.actor,
          input,
        ),
      ),
    ),

  /** The text of a text document, for the editor. */
  content: hubProcedure
    .input(documentInput)
    .query(({ ctx, input }) =>
      runHub(() =>
        readTextContent(
          ctx.db,
          getDocumentStorage(ctx.db),
          ctx.actor,
          input.documentPublicId,
        ),
      ),
    ),

  replaceText: hubProcedure
    .input(
      documentInput.extend({
        content: z.string().max(410_000),
        expectedUpdatedAt: z.string().max(40).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() =>
        replaceTextContent(
          ctx.db,
          getDocumentStorage(ctx.db),
          ctx.actor,
          input,
        ),
      ),
    ),

  update: hubProcedure
    .input(
      z.object({
        documentPublicId: id,
        title: z.string().max(300).optional(),
        description: z.string().max(2000).nullish(),
        folderPublicId: id.nullish(),
        audience: audienceInput.optional(),
        /** Who can change the content: the assigned editors, or every reader. */
        editAccess: z.enum(["assigned", "readers"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runHub(() => updateDocument(ctx.db, ctx.actor, input)),
    ),

  /** Projects, departments and members to pick 指定的人 from. */
  audienceOptions: hubProcedure.query(({ ctx }) =>
    runHub(() => getAudienceOptions(ctx.db, ctx.actor)),
  ),

  delete: hubProcedure
    .input(documentInput)
    .mutation(({ ctx, input }) =>
      runHub(() =>
        deleteDocument(
          ctx.db,
          getDocumentStorage(ctx.db),
          ctx.actor,
          input.documentPublicId,
        ),
      ),
    ),

  requestEdit: hubProcedure
    .input(documentInput.extend({ note: z.string().max(1000).nullish() }))
    .mutation(({ ctx, input }) =>
      runHub(() => requestEdit(ctx.db, ctx.actor, input)),
    ),

  /** Pending requests the signed-in person may decide. */
  requests: hubProcedure.query(({ ctx }) =>
    runHub(() => listDecidableRequests(ctx.db, ctx.actor)),
  ),

  decideRequest: hubProcedure
    .input(z.object({ requestPublicId: id, approve: z.boolean() }))
    .mutation(({ ctx, input }) =>
      runHub(() => decideEditRequest(ctx.db, ctx.actor, input)),
    ),

  candidates: hubProcedure
    .input(documentInput.extend({ search: z.string().max(100) }))
    .query(({ ctx, input }) =>
      runHub(() => findEditorCandidates(ctx.db, ctx.actor, input)),
    ),

  grantEditor: hubProcedure
    .input(userInput)
    .mutation(({ ctx, input }) =>
      runHub(() => grantEditor(ctx.db, ctx.actor, input)),
    ),

  revokeEditor: hubProcedure
    .input(userInput)
    .mutation(({ ctx, input }) =>
      runHub(() => revokeEditor(ctx.db, ctx.actor, input)),
    ),
});
