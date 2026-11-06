import { z } from "zod";

import type { AdminActor } from "../accounts/account.service";
import type { Db } from "../db";
import type { RestRequest, RestResponse } from "../shared/rest";
import type { DocumentDetail, DocumentSummary } from "./library.service";
import type { DocumentStorage } from "./storage";
import { HubError } from "../shared/errors";
import { audienceSchema, getAudienceOptions } from "./audience.service";
import { updateDocument } from "./document.service";
import { createFolder, getDocumentDetail, getLibrary } from "./library.service";
import {
  createTextDocument,
  readTextContent,
  replaceTextContent,
} from "./text.service";

export type { RestRequest, RestResponse } from "../shared/rest";
export { statusOfHubError } from "../shared/rest";

/**
 * The document library as a REST API, for the command line (`bshub doc`).
 *
 * This is the transport-free part: it takes the parts of a request and the
 * caller's identity and returns a status and a body. The Next.js route does the
 * authentication (an API key or a browser session), the rate limit and the
 * reading and writing of HTTP. Every rule still lives in the use cases, so the
 * API can do exactly what the web app can do for the same person, and no more.
 * That includes choosing who can read a document (`audience`) and whether its
 * readers can change its content (`editAccess`), which the web app's 谁能看 and
 * 谁能改 do for anyone who can edit it.
 *
 * Deliberately not here, whatever the caller's rights: deleting a document or a
 * folder, and handing out or deciding edit rights. An API key has no scope yet,
 * so a leaked one must not be able to remove files or pass on the right to
 * change them. Those stay in the web app.
 */

const id = z.string().min(1).max(32);

const createBody = z.object({
  title: z.string(),
  filename: z.string(),
  content: z.string(),
  description: z.string().nullish(),
  folderPublicId: id.nullish(),
  /** Who can read it; wins over `readable`. */
  audience: audienceSchema.optional(),
  readable: z.boolean().optional(),
});

const patchBody = z.object({
  title: z.string().optional(),
  description: z.string().nullish(),
  folderPublicId: id.nullish(),
  /** Who can read it; wins over `readable`. */
  audience: audienceSchema.optional(),
  readable: z.boolean().optional(),
  /** Who can change the content: the assigned editors, or every reader too. */
  editAccess: z.enum(["assigned", "readers"]).optional(),
});

const contentBody = z.object({
  content: z.string(),
  /** The `updatedAt` from the read; the save is refused if it has changed since. */
  expectedUpdatedAt: z.string().optional(),
});

const folderBody = z.object({
  name: z.string(),
  parentPublicId: id.nullish(),
});

function body<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new HubError(
      "INVALID_INPUT",
      result.error.issues[0]?.message ?? "请求内容不对",
    );
  }
  return result.data;
}

/** What the API calls a document. Dates are ISO strings. */
function documentJson(doc: DocumentSummary) {
  return {
    publicId: doc.publicId,
    title: doc.title,
    description: doc.description,
    filename: doc.filename,
    ext: doc.ext,
    size: doc.size,
    folderPublicId: doc.folderPublicId,
    readable: doc.readable,
    audience: doc.audience,
    editAccess: doc.editAccess,
    canEdit: doc.canEdit,
    canEditContent: doc.canEditContent,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** One document on its own also names its 指定的人, for those who can change them. */
function detailJson(doc: DocumentDetail) {
  return { ...documentJson(doc), readers: doc.readers };
}

const ok = (payload: unknown, status = 200): RestResponse => ({
  status,
  body: payload,
});

const failure = (status: number, message: string): RestResponse => ({
  status,
  body: { message },
});

const notFound = () => failure(404, "没有这个接口");
const wrongMethod = () => failure(405, "这个接口不支持这种请求方法");

export async function handleDocumentsRest(
  db: Db,
  storage: DocumentStorage | null,
  actor: AdminActor,
  request: RestRequest,
): Promise<RestResponse> {
  const { method, segments } = request;
  const detail = async (publicId: string) =>
    detailJson(await getDocumentDetail(db, storage, actor, publicId));

  // /documents
  if (segments.length === 0) {
    if (method === "GET") {
      const library = await getLibrary(db, storage, actor, {
        folderPublicId: request.query.folder ?? null,
        search: request.query.search ?? null,
      });
      return ok({
        folders: library.folders.map((folder) => ({
          publicId: folder.publicId,
          name: folder.name,
          parentPublicId: folder.parentPublicId,
        })),
        documents: library.documents.map(documentJson),
      });
    }
    if (method === "POST") {
      const input = body(createBody, request.body);
      const created = await createTextDocument(db, storage, actor, input);
      return ok(await detail(created.publicId), 201);
    }
    return wrongMethod();
  }

  const [first, second] = segments;

  // /documents/folders
  if (first === "folders") {
    if (segments.length !== 1) return notFound();
    if (method !== "POST") return wrongMethod();
    const input = body(folderBody, request.body);
    const created = await createFolder(db, actor, input);
    return ok(
      {
        publicId: created.publicId,
        name: created.name,
        parentPublicId: input.parentPublicId ?? null,
      },
      201,
    );
  }

  // /documents/audience-options: who 指定的人 can be, with their userIds
  if (first === "audience-options") {
    if (segments.length !== 1) return notFound();
    if (method !== "GET") return wrongMethod();
    return ok(await getAudienceOptions(db, actor));
  }

  // /documents/{id} and /documents/{id}/content
  const publicId = first;
  if (!publicId) return notFound();

  if (segments.length === 1) {
    if (method === "GET") return ok(await detail(publicId));
    if (method === "PATCH") {
      await updateDocument(db, actor, {
        ...body(patchBody, request.body),
        documentPublicId: publicId,
      });
      return ok(await detail(publicId));
    }
    return wrongMethod();
  }

  if (segments.length === 2 && second === "content") {
    if (method === "GET") {
      const text = await readTextContent(db, storage, actor, publicId);
      return ok({
        content: text.content,
        updatedAt: text.updatedAt.toISOString(),
      });
    }
    if (method === "PUT") {
      const input = body(contentBody, request.body);
      const result = await replaceTextContent(db, storage, actor, {
        documentPublicId: publicId,
        content: input.content,
        expectedUpdatedAt: input.expectedUpdatedAt,
      });
      return ok(result);
    }
    return wrongMethod();
  }

  return notFound();
}
