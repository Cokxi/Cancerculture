import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export const USER_FLAG_CATEGORIES = Object.freeze([
  "trolling_low_effort",
  "suspicious_behavior",
  "other",
] as const);

export type UserFlagCategory =
  (typeof USER_FLAG_CATEGORIES)[number];
export type UserFlagStatus =
  | "open"
  | "escalated"
  | "resolved"
  | "dismissed";
export type UserFlagReviewAction =
  | "resolved"
  | "dismissed"
  | "escalated"
  | "banned_resolved";

export type UserFlagEvent = Readonly<{
  eventId: string;
  eventType:
    | "case_created"
    | "legacy_case_migrated"
    | "case_escalated"
    | "case_resolved"
    | "case_dismissed"
    | "case_banned_and_resolved";
  previousStatus: UserFlagStatus | null;
  newStatus: UserFlagStatus;
  actorDiscordUserId: string | null;
  actorAccountId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  occurredAt: string | null;
  recordedAt: string;
  reason: string | null;
  comment: string | null;
  caseVersion: number;
}>;

export type UserFlagCase = Readonly<{
  caseId: string;
  discordUserId: string;
  userDisplayName: string;
  status: UserFlagStatus;
  category: UserFlagCategory | null;
  reason: string | null;
  comment: string | null;
  submissionId: number | null;
  createdAt: string | null;
  recordedAt: string;
  createdByDiscordUserId: string | null;
  createdByDisplayName: string | null;
  escalatedAt: string | null;
  escalatedByDiscordUserId: string | null;
  escalatedByDisplayName: string | null;
  escalationReason: string | null;
  reviewedAt: string | null;
  reviewedByDiscordUserId: string | null;
  reviewedByDisplayName: string | null;
  reviewReason: string | null;
  rowVersion: number;
  events: readonly UserFlagEvent[];
}>;

export type UserFlagMutationResult = Readonly<{
  caseId: string;
  status: UserFlagStatus;
  rowVersion: number;
  replayed: boolean;
  websiteBanApplied?: boolean;
}>;

export type UserFlagCasePage = Readonly<{
  items: readonly UserFlagCase[];
  total: number;
  limit: number;
  offset: number;
}>;

export type UserFlagActiveStatus = Readonly<{
  active: boolean;
  status: "open" | "escalated" | null;
}>;

export type UserWarningAutoFlagEvent = Readonly<{
  eventId: string;
  eventType: "opened" | "recomputed" | "closed";
  activeWarningCount: number;
  triggeredByActiveCount: boolean;
  triggeredByFourteenDay: boolean;
  caseVersion: number;
  occurredAt: string;
  recordedAt: string;
}>;

export type UserWarningAutoFlagCase = Readonly<{
  caseId: string;
  discordUserId: string;
  userDisplayName: string;
  generation: number;
  status: "open" | "closed";
  activeWarningCount: number;
  triggeredByActiveCount: boolean;
  triggeredByFourteenDay: boolean;
  openedAt: string;
  closedAt: string | null;
  rowVersion: number;
  events: readonly UserWarningAutoFlagEvent[];
}>;

export type UserWarningAutoFlagCasePage = Readonly<{
  items: readonly UserWarningAutoFlagCase[];
  total: number;
  limit: number;
  offset: number;
}>;

type SupabaseRpcError = Readonly<{
  code?: string | null;
  message?: string | null;
}>;

export class UserFlagDatabaseError extends Error {
  readonly databaseCode: string | null;

  constructor(error: SupabaseRpcError) {
    super(error.message ?? "User flag operation failed");
    this.name = "UserFlagDatabaseError";
    this.databaseCode = error.code ?? null;
  }
}

function assertUuid(value: string, fieldName: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value
    )
  ) {
    throw new TypeError(`Invalid ${fieldName}`);
  }
}

function assertCategory(value: string): asserts value is UserFlagCategory {
  if (!(USER_FLAG_CATEGORIES as readonly string[]).includes(value)) {
    throw new TypeError("Invalid category");
  }
}

function assertText(
  value: string,
  fieldName: string,
  minimum: number,
  maximum: number
) {
  const length = value.trim().length;
  if (length < minimum || length > maximum) {
    throw new TypeError(`Invalid ${fieldName}`);
  }
}

function unwrapRpc<T>(data: unknown, error: SupabaseRpcError | null): T {
  if (error) {
    throw new UserFlagDatabaseError(error);
  }

  return data as T;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parseUserWarningAutoFlagEvent(
  value: unknown
): UserWarningAutoFlagEvent | null {
  const event = record(value);
  if (
    !hasExactKeys(event, [
      "activeWarningCount",
      "caseVersion",
      "eventId",
      "eventType",
      "occurredAt",
      "recordedAt",
      "triggeredByActiveCount",
      "triggeredByFourteenDay",
    ]) ||
    typeof event.eventId !== "string" || !/^[1-9][0-9]*$/u.test(event.eventId) ||
    (event.eventType !== "opened" &&
      event.eventType !== "recomputed" &&
      event.eventType !== "closed") ||
    !isNonNegativeInteger(event.activeWarningCount) ||
    typeof event.triggeredByActiveCount !== "boolean" ||
    typeof event.triggeredByFourteenDay !== "boolean" ||
    !isPositiveInteger(event.caseVersion) ||
    !isTimestamp(event.occurredAt) ||
    !isTimestamp(event.recordedAt) ||
    (event.eventType === "closed"
      ? event.triggeredByActiveCount || event.triggeredByFourteenDay
      : !event.triggeredByActiveCount && !event.triggeredByFourteenDay)
  ) return null;

  return Object.freeze(event as UserWarningAutoFlagEvent);
}

function parseUserWarningAutoFlagCase(
  value: unknown
): UserWarningAutoFlagCase | null {
  const flagCase = record(value);
  const rawEvents = Array.isArray(flagCase.events) ? flagCase.events : null;
  const parsedEvents = rawEvents?.map(parseUserWarningAutoFlagEvent) ?? [];
  const statusIsValid = flagCase.status === "open" || flagCase.status === "closed";
  if (
    !hasExactKeys(flagCase, [
      "activeWarningCount",
      "caseId",
      "closedAt",
      "discordUserId",
      "events",
      "generation",
      "openedAt",
      "rowVersion",
      "status",
      "triggeredByActiveCount",
      "triggeredByFourteenDay",
      "userDisplayName",
    ]) ||
    typeof flagCase.caseId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(flagCase.caseId) ||
    typeof flagCase.discordUserId !== "string" ||
      flagCase.discordUserId.length < 1 || flagCase.discordUserId.length > 100 ||
    typeof flagCase.userDisplayName !== "string" ||
      flagCase.userDisplayName.length < 1 || flagCase.userDisplayName.length > 200 ||
    !isPositiveInteger(flagCase.generation) ||
    !statusIsValid ||
    !isNonNegativeInteger(flagCase.activeWarningCount) ||
    typeof flagCase.triggeredByActiveCount !== "boolean" ||
    typeof flagCase.triggeredByFourteenDay !== "boolean" ||
    !isTimestamp(flagCase.openedAt) ||
    (flagCase.closedAt !== null && !isTimestamp(flagCase.closedAt)) ||
    !isPositiveInteger(flagCase.rowVersion) ||
    rawEvents === null || parsedEvents.length === 0 ||
    parsedEvents.some((event) => event === null)
  ) return null;

  const events = parsedEvents.filter(
    (event): event is UserWarningAutoFlagEvent => event !== null
  );
  if (
    events[0]?.eventType !== "opened" ||
    events.some((event, index) => index > 0 &&
      event.caseVersion <= events[index - 1].caseVersion) ||
    events.at(-1)?.caseVersion !== flagCase.rowVersion ||
    (flagCase.status === "open"
      ? flagCase.closedAt !== null ||
        (!flagCase.triggeredByActiveCount && !flagCase.triggeredByFourteenDay) ||
        events.at(-1)?.eventType === "closed"
      : flagCase.closedAt === null ||
        flagCase.triggeredByActiveCount || flagCase.triggeredByFourteenDay ||
        events.at(-1)?.eventType !== "closed")
  ) return null;

  return Object.freeze({
    ...(flagCase as Omit<UserWarningAutoFlagCase, "events">),
    events: Object.freeze(events),
  });
}

function parseUserWarningAutoFlagCasePage(
  value: unknown,
  expectedLimit: number,
  expectedOffset: number
): UserWarningAutoFlagCasePage {
  const page = record(value);
  const rawItems = Array.isArray(page.items) ? page.items : null;
  const parsedItems = rawItems?.map(parseUserWarningAutoFlagCase) ?? [];
  if (
    !hasExactKeys(page, ["items", "limit", "offset", "total"]) ||
    rawItems === null || parsedItems.some((item) => item === null) ||
    !isNonNegativeInteger(page.total) ||
    page.limit !== expectedLimit || page.offset !== expectedOffset ||
    Number(page.total) < expectedOffset + parsedItems.length
  ) {
    throw new AuthError(
      503,
      "Automatic flag cases temporarily unavailable",
      "USER_WARNING_AUTO_FLAG_INVALID_RESPONSE"
    );
  }

  return Object.freeze({
    items: Object.freeze(parsedItems.filter(
      (item): item is UserWarningAutoFlagCase => item !== null
    )),
    total: Number(page.total),
    limit: expectedLimit,
    offset: expectedOffset,
  });
}

export async function createUserFlagCase(input: {
  targetDiscordUserId: string;
  category: string;
  reason: string;
  comment?: string;
  submissionId?: number;
  idempotencyKey: string;
}): Promise<UserFlagMutationResult> {
  assertCategory(input.category);
  assertText(input.targetDiscordUserId, "targetDiscordUserId", 1, 100);
  assertText(input.reason, "reason", 3, 1000);
  if (input.comment) {
    assertText(input.comment, "comment", 1, 2000);
  }
  assertUuid(input.idempotencyKey, "idempotencyKey");

  const authorization = await requireDynamicTeamCapability(
    "users.flag.create"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "create_user_flag_case",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_target_discord_user_id: input.targetDiscordUserId.trim(),
      p_category: input.category,
      p_reason: input.reason.trim(),
      p_comment: input.comment?.trim() || null,
      p_submission_id: input.submissionId ?? null,
      p_idempotency_key: input.idempotencyKey,
    }
  );

  return unwrapRpc<UserFlagMutationResult>(data, error);
}

export async function getUserFlagActiveStatus(
  targetDiscordUserId: string
): Promise<UserFlagActiveStatus> {
  assertText(targetDiscordUserId, "targetDiscordUserId", 1, 100);
  const authorization = await requireDynamicTeamCapability(
    "users.flag.create"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "get_user_flag_active_status",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_target_discord_user_id: targetDiscordUserId.trim(),
    }
  );

  return unwrapRpc<UserFlagActiveStatus>(data, error);
}

export async function listUserFlagCases({
  section,
  query = "",
  limit = 50,
  offset = 0,
}: {
  section: "active" | "history";
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<UserFlagCasePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid limit");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Invalid offset");
  }
  if (query.length > 100) throw new TypeError("Invalid query");
  const authorization = await requireDynamicTeamCapability(
    "users.flag.view"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_user_flag_cases",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_section: section,
      p_query: query.trim() || null,
      p_limit: limit,
      p_offset: offset,
    }
  );

  return unwrapRpc<UserFlagCasePage>(data, error);
}

export async function listUserWarningAutoFlagCases({
  section,
  query = "",
  limit = 50,
  offset = 0,
}: {
  section: "active" | "history";
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<UserWarningAutoFlagCasePage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid limit");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Invalid offset");
  }
  if (query.length > 100) throw new TypeError("Invalid query");

  const authorization = await requireDynamicTeamCapability("users.flag.view");
  const { data, error } = await supabaseAdmin.rpc(
    "list_user_warning_auto_flag_cases",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_section: section,
      p_query: query.trim() || null,
      p_limit: limit,
      p_offset: offset,
    }
  );

  if (error) {
    if (error.code === "42501") {
      throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
    }
    throw new AuthError(
      503,
      "Automatic flag cases temporarily unavailable",
      "USER_WARNING_AUTO_FLAG_UNAVAILABLE"
    );
  }

  return parseUserWarningAutoFlagCasePage(data, limit, offset);
}

export async function listUserFlagReviewWorklist(
  limit = 100
): Promise<readonly UserFlagCase[]> {
  const authorization = await requireDynamicTeamCapability(
    "users.flag.review"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "list_user_flag_review_worklist",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_limit: limit,
    }
  );

  return unwrapRpc<readonly UserFlagCase[]>(data, error);
}

export async function getUserFlagCase(
  caseId: string
): Promise<UserFlagCase> {
  assertUuid(caseId, "caseId");
  const authorization = await getTeamAuthorizationContext();
  const canView = hasResolvedTeamCapability(
    authorization,
    "users.flag.view"
  );
  const canReview = hasResolvedTeamCapability(
    authorization,
    "users.flag.review"
  );

  if (!canView && !canReview) {
    throw new AuthError(403, "Forbidden", "TEAM_CAPABILITY_DENIED");
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_user_flag_case",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_case_id: caseId,
    }
  );

  return unwrapRpc<UserFlagCase>(data, error);
}

export async function reviewUserFlagCase(input: {
  caseId: string;
  expectedRowVersion: number;
  status: UserFlagReviewAction;
  reviewReason: string;
  idempotencyKey: string;
}): Promise<UserFlagMutationResult> {
  assertUuid(input.caseId, "caseId");
  assertUuid(input.idempotencyKey, "idempotencyKey");
  assertText(input.reviewReason, "reviewReason", 3, 1000);
  if (
    !Number.isSafeInteger(input.expectedRowVersion) ||
    input.expectedRowVersion < 1
  ) {
    throw new TypeError("Invalid expectedRowVersion");
  }
  if (
    !["resolved", "dismissed", "escalated", "banned_resolved"].includes(
      input.status
    )
  ) {
    throw new TypeError("Invalid status");
  }

  const authorization = await requireDynamicTeamCapability(
    "users.flag.review"
  );
  const { data, error } = await supabaseAdmin.rpc(
    "review_user_flag_case",
    {
      p_actor_discord_user_id: authorization.discord_user_id,
      p_case_id: input.caseId,
      p_expected_row_version: input.expectedRowVersion,
      p_status: input.status,
      p_review_reason: input.reviewReason.trim(),
      p_idempotency_key: input.idempotencyKey,
    }
  );

  return unwrapRpc<UserFlagMutationResult>(data, error);
}
