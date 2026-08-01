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
