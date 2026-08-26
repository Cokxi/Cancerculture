import "server-only";

import { AuthError } from "@/lib/auth/AuthError";
import {
  getTeamAuthorizationContext,
  hasResolvedTeamCapability,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WARNING_CATEGORIES = ["spam", "hate_speech", "other"] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function timestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function warningRpcError(error: { code?: string; message?: string }) {
  const message = error.message ?? "";
  if (error.code === "42501") {
    return new AuthError(403, "Forbidden", "COMMENT_WARNING_FORBIDDEN");
  }
  if (error.code === "22023") {
    return new AuthError(400, "Invalid Warning", "COMMENT_WARNING_INVALID");
  }
  if (error.code === "P0002") {
    return new AuthError(404, "Comment unavailable", "COMMENT_WARNING_UNAVAILABLE");
  }
  if (error.code === "PT409") {
    if (message.includes("SOURCE_ALREADY_USED")) {
      return new AuthError(
        409,
        "Warning already issued",
        "COMMENT_WARNING_ALREADY_ISSUED",
      );
    }
    if (message.includes("STALE_SOURCE_VERSION")) {
      return new AuthError(409, "Comment changed", "COMMENT_WARNING_STALE");
    }
    if (message.includes("IDEMPOTENCY_CONFLICT")) {
      return new AuthError(
        409,
        "Request conflict",
        "COMMENT_WARNING_IDEMPOTENCY_CONFLICT",
      );
    }
    return new AuthError(409, "Warning unavailable", "COMMENT_WARNING_UNAVAILABLE");
  }
  return new AuthError(503, "Warning unavailable", "COMMENT_WARNING_UNAVAILABLE");
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[COMMENT_WARNING] RPC failed", {
      functionName,
      code: error.code,
    });
    throw warningRpcError(error);
  }
  return record(data);
}

export async function loadCommunityCommentWarningAccess() {
  const context = await getTeamAuthorizationContext();
  return {
    canIssueWarning: hasResolvedTeamCapability(
      context,
      "users.warnings.issue",
    ),
  };
}

export async function loadCommunityCommentWarningTarget(publicCommentId: string) {
  if (!UUID_PATTERN.test(publicCommentId)) {
    throw new AuthError(400, "Invalid Comment", "COMMENT_WARNING_INVALID");
  }
  const context = await requireDynamicTeamCapability("users.warnings.issue");
  const value = await rpc("get_user_warning_issue_target", {
    p_actor_discord_user_id: context.discord_user_id,
    p_public_comment_id: publicCommentId,
  });
  if (exactKeys(value, ["outcome"]) && value.outcome === "not_found") {
    throw new AuthError(404, "Comment unavailable", "COMMENT_WARNING_UNAVAILABLE");
  }
  if (
    !exactKeys(value, [
      "alreadyWarned",
      "available",
      "objectVersion",
      "outcome",
      "publicCommentId",
      "text",
      "textVersion",
    ]) ||
    value.outcome !== "found" ||
    value.publicCommentId !== publicCommentId ||
    !positiveInteger(value.objectVersion) ||
    !positiveInteger(value.textVersion) ||
    typeof value.available !== "boolean" ||
    typeof value.alreadyWarned !== "boolean" ||
    !(
      value.available
        ? typeof value.text === "string" &&
          value.text.length >= 1 && value.text.length <= 10_000
        : value.text === null
    )
  ) {
    throw new AuthError(503, "Warning unavailable", "COMMENT_WARNING_UNAVAILABLE");
  }
  return {
    outcome: "found" as const,
    publicCommentId,
    objectVersion: value.objectVersion as number,
    textVersion: value.textVersion as number,
    text: value.text as string | null,
    available: value.available,
    alreadyWarned: value.alreadyWarned,
  };
}

export async function issueCommunityCommentWarning(input: Record<string, unknown>) {
  if (!exactKeys(input, [
    "category",
    "expectedObjectVersion",
    "expectedTextVersion",
    "publicCommentId",
    "reason",
    "requestId",
  ])) {
    throw new AuthError(400, "Invalid Warning", "COMMENT_WARNING_INVALID");
  }
  const publicCommentId = typeof input.publicCommentId === "string"
    ? input.publicCommentId
    : "";
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (
    !UUID_PATTERN.test(publicCommentId) ||
    !UUID_PATTERN.test(requestId) ||
    !WARNING_CATEGORIES.includes(category as typeof WARNING_CATEGORIES[number]) ||
    !positiveInteger(input.expectedObjectVersion) ||
    !positiveInteger(input.expectedTextVersion) ||
    reason.length < 3 || reason.length > 1000
  ) {
    throw new AuthError(400, "Invalid Warning", "COMMENT_WARNING_INVALID");
  }

  const context = await requireDynamicTeamCapability("users.warnings.issue");
  const value = await rpc("issue_user_warning", {
    p_actor_discord_user_id: context.discord_user_id,
    p_source_public_comment_id: publicCommentId,
    p_expected_comment_object_version: input.expectedObjectVersion,
    p_expected_comment_text_version: input.expectedTextVersion,
    p_category: category,
    p_reason: reason,
    p_request_id: requestId,
  });
  if (
    value.sourcePublicCommentId !== publicCommentId ||
    ![1, 3, 7, 14].includes(Number(value.tierDays)) ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new AuthError(503, "Warning unavailable", "COMMENT_WARNING_UNAVAILABLE");
  }
  return {
    outcome: "issued" as const,
    publicCommentId,
    tierDays: value.tierDays as 1 | 3 | 7 | 14,
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    replayed: value.replayed,
  };
}
