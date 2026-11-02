/**
 * The only entry point of this package that is safe to import in the browser:
 * constants and pure helpers, nothing that touches Node or the database.
 */

/**
 * Request header that carries a registration-link token on sign-up. The token
 * travels in a header, and in the link's `#fragment`, so that it never appears
 * in a URL the server sees and therefore never lands in access logs.
 */
export const HUB_GRANT_HEADER = "x-hub-grant";

/** Path of the registration page; the token goes after `#`. */
export const HUB_JOIN_PATH = "/join";

export function buildJoinLink(origin: string, token: string): string {
  return `${origin}${HUB_JOIN_PATH}#${token}`;
}

export type { Decision, HubPermission, HubRole } from "./accounts/roles";
export {
  can,
  hubPermissions,
  hubRoles,
  permissionsOf,
  roleLabels,
} from "./accounts/roles";

export type {
  DueState,
  FunctionKey,
  Stage,
  TaskView,
} from "./tasks/task.policy";
export {
  DUE_SOON_DAYS,
  functionKeys,
  functionNames,
  stageNames,
  stages,
  taskViews,
} from "./tasks/task.policy";

export type { EditableProjectRole } from "./permissions/permission.policy";
export {
  editableProjectRoles,
  permissionGroupLabels,
  permissionGroups,
  permissionLabels,
  projectRoleLabels,
} from "./permissions/permission.policy";

export type { FunctionColors } from "./settings/function-colors.policy";
export {
  DEFAULT_FUNCTION_COLORS,
  functionColorPalette,
  isHexColor,
} from "./settings/function-colors.policy";

export type {
  ReviewDecision,
  ReviewStatus,
  SiteAccess,
  SitePermission,
  VolunteerStatus,
} from "./site/site.policy";
export {
  canOnSite,
  reviewStatuses,
  reviewStatusLabels,
  siteAccessLabels,
  siteAccessLevels,
  VOLUNTEER_NOTES_MAX,
  volunteerStatuses,
  volunteerStatusLabels,
} from "./site/site.policy";

export {
  canReadMail,
  hasRemoteImages,
  inboxAttachmentHref,
  INBOX_PAGE_SIZE,
  MAIL_FRAME_SANDBOX,
  mailFrameCsp,
  mailFrameDocument,
  splitAddress,
} from "./inbox/inbox.policy";

export { IMPORT_ACCEPT, importSizeProblem } from "./documents/document.policy";

export type {
  McpTokenDays,
  McpToolGroup,
  McpToolInfo,
  McpUrls,
} from "./mcp/catalog";
export {
  MAX_MCP_TOKENS,
  MCP_TOKEN_DAYS,
  MCP_TOKEN_NAME_MAX,
  HUB_MCP_AUTHORIZE_PATH,
  HUB_MCP_GUIDE_PATH,
  HUB_MCP_PATH,
  mcpNotOffered,
  mcpToolGroupLabels,
  mcpToolGroups,
  mcpTools,
  mcpUrls,
  toolsFor,
} from "./mcp/catalog";

export type {
  AnswerInput,
  ChoiceField,
  ChoiceOption,
  FieldType,
  FormAccess,
  FormDefinition,
  FormDefinitionInput,
  FormField,
  FormPhase,
  FormSettings,
  FormStatus,
  LikeMode,
  Problem,
  QuestionField,
  StoredAnswer,
  TextFormat,
  WallMode,
} from "./forms/form.model";
export {
  answerText,
  checkAnswers,
  checkDefinition,
  closedReasonText,
  DEFAULT_SETTINGS,
  FORM_LIMITS,
  fieldLabel,
  fieldTypes,
  formAccessLevels,
  formStatuses,
  isQuestion,
  likeModes,
  newFieldId,
  normaliseUrl,
  textFormats,
  wallModes,
} from "./forms/form.model";
export {
  IMAGE_ACCEPT,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  imageSizeProblem,
} from "./forms/image.policy";
export type {
  FillView,
  ManagedResponse,
  QuestionSummary,
  SubmitResult,
  Wall,
  WallEntry,
} from "./forms/response.service";

/** Request header carrying the secret that lets a browser change its anonymous answer. */
export const FORM_TOKEN_HEADER = "x-hub-form-token";
/** Request header carrying a browser's random key, so its anonymous 👍 counts once. */
export const FORM_VOTER_HEADER = "x-hub-form-voter";

export function formHref(publicId: string): string {
  return `/forms/${publicId}`;
}

export function formImageSrc(imagePublicId: string): string {
  return `/api/hub/forms/images/${imagePublicId}`;
}

/** A value as it arrives through JSON: every Date becomes an ISO string. */
export type Jsonified<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;
