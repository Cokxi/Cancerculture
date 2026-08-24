import "server-only";

import { createHash } from "node:crypto";
import { AuthError } from "@/lib/auth/AuthError";
import {
  getTeamAuthorizationContext,
  requireDynamicTeamCapability,
} from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    const forbidden = error.code === "42501";
    console.error("[COMMENT_MODERATION] RPC failed", { functionName, code: error.code });
    throw new AuthError(
      forbidden ? 403 : error.code === "22023" ? 400 : 503,
      forbidden ? "Forbidden" : "Comment moderation unavailable",
      forbidden ? "COMMENT_MODERATION_FORBIDDEN" :
        error.code === "22023" ? "COMMENT_MODERATION_INVALID" : "COMMENT_MODERATION_UNAVAILABLE",
    );
  }
  return record(data);
}

export async function loadCommunityCommentReviewCaseDetail(
  actorDiscordUserId: string,
  caseId: string,
  topicKey: string,
) {
  if (!UUID_PATTERN.test(caseId) || !["comment_reports", "comment_spam"].includes(topicKey)) {
    throw new AuthError(400, "Invalid case", "TEAM_INBOX_CASE_INVALID");
  }
  return rpc("get_community_comment_review_case_detail", {
    p_actor_discord_user_id: actorDiscordUserId,
    p_case_id: caseId,
    p_expected_topic_key: topicKey,
  });
}

export async function resolveCommunityCommentReviewCase(input: Record<string, unknown>) {
  const topicKey = typeof input.topicKey === "string" ? input.topicKey : "";
  const action = typeof input.action === "string" ? input.action : "";
  const caseId = typeof input.caseId === "string" ? input.caseId : "";
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  const publicCommentId = typeof input.publicCommentId === "string" ? input.publicCommentId : null;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const integers = [
    input.expectedRowVersion,
    input.expectedWorkVersion,
    input.expectedSourceVersion,
    input.expectedDomainVersion,
  ];
  if (
    !["comment_reports", "comment_spam"].includes(topicKey) ||
    !["no_action", "remove"].includes(action) ||
    !UUID_PATTERN.test(caseId) ||
    !UUID_PATTERN.test(requestId) ||
    reason.length < 3 || reason.length > 1000 ||
    integers.some((value) => !Number.isSafeInteger(value) || Number(value) < 1) ||
    (action === "remove" && (
      !publicCommentId || !UUID_PATTERN.test(publicCommentId) ||
      !Number.isSafeInteger(input.expectedObjectVersion) || Number(input.expectedObjectVersion) < 1 ||
      !Number.isSafeInteger(input.expectedModerationVersion) || Number(input.expectedModerationVersion) < 0
    ))
  ) throw new AuthError(400, "Invalid review", "COMMENT_REVIEW_INVALID");

  const viewCapability = topicKey === "comment_reports"
    ? "community.comment_reports.view"
    : "community.comment_spam.view";
  const reviewCapability = topicKey === "comment_reports"
    ? "community.comment_reports.review"
    : "community.comment_spam.review";
  await requireDynamicTeamCapability(viewCapability);
  const context = await requireDynamicTeamCapability(reviewCapability);
  if (action === "remove") await requireDynamicTeamCapability("community.comments.moderate");
  const requestHash = createHash("sha256").update(JSON.stringify({
    topicKey, caseId, action, publicCommentId, reason,
    expectedRowVersion: input.expectedRowVersion,
    expectedWorkVersion: input.expectedWorkVersion,
    expectedSourceVersion: input.expectedSourceVersion,
    expectedDomainVersion: input.expectedDomainVersion,
    expectedObjectVersion: action === "remove" ? input.expectedObjectVersion : null,
    expectedModerationVersion: action === "remove" ? input.expectedModerationVersion : null,
  })).digest("hex");
  return rpc("resolve_community_comment_review_case", {
    p_actor_discord_user_id: context.discord_user_id,
    p_topic_key: topicKey,
    p_case_id: caseId,
    p_action: action,
    p_public_comment_id: publicCommentId,
    p_expected_row_version: input.expectedRowVersion,
    p_expected_work_version: input.expectedWorkVersion,
    p_expected_source_version: input.expectedSourceVersion,
    p_expected_domain_version: input.expectedDomainVersion,
    p_expected_object_version: action === "remove" ? input.expectedObjectVersion : null,
    p_expected_moderation_version: action === "remove" ? input.expectedModerationVersion : null,
    p_internal_reason: reason,
    p_request_id: requestId,
    p_request_hash: requestHash,
  });
}

export async function loadCommunityCommentModerationTarget(publicCommentId: string) {
  if (!UUID_PATTERN.test(publicCommentId)) {
    throw new AuthError(400, "Invalid Comment", "COMMENT_MODERATION_INVALID");
  }
  const context = await requireDynamicTeamCapability("community.comments.moderate");
  return rpc("get_community_comment_moderation_target", {
    p_actor_discord_user_id: context.discord_user_id,
    p_public_comment_id: publicCommentId,
  });
}

export async function moderateCommunityComment(input: Record<string, unknown>) {
  const publicCommentId = typeof input.publicCommentId === "string" ? input.publicCommentId : "";
  const requestId = typeof input.requestId === "string" ? input.requestId : "";
  const action = typeof input.action === "string" ? input.action : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!UUID_PATTERN.test(publicCommentId) || !UUID_PATTERN.test(requestId)
    || !["remove", "restore"].includes(action)
    || !Number.isSafeInteger(input.expectedObjectVersion) || Number(input.expectedObjectVersion) < 1
    || !Number.isSafeInteger(input.expectedModerationVersion) || Number(input.expectedModerationVersion) < 0
    || reason.length < 3 || reason.length > 1000
  ) throw new AuthError(400, "Invalid moderation", "COMMENT_MODERATION_INVALID");
  const context = await requireDynamicTeamCapability("community.comments.moderate");
  const requestHash = createHash("sha256").update(JSON.stringify({
    publicCommentId, action, reason,
    expectedObjectVersion: input.expectedObjectVersion,
    expectedModerationVersion: input.expectedModerationVersion,
  })).digest("hex");
  return rpc("moderate_community_comment", {
    p_actor_discord_user_id: context.discord_user_id,
    p_public_comment_id: publicCommentId,
    p_action: action,
    p_expected_object_version: input.expectedObjectVersion,
    p_expected_moderation_version: input.expectedModerationVersion,
    p_internal_reason: reason,
    p_request_id: requestId,
    p_request_hash: requestHash,
  });
}

export async function loadCommunityCommentModerationLog() {
  const context = await requireDynamicTeamCapability("logs.community_comment_moderation.view");
  return rpc("get_community_comment_moderation_log", {
    p_actor_discord_user_id: context.discord_user_id,
    p_before_created_at: null,
    p_before_id: null,
    p_limit: 50,
  });
}

export async function getCommentModerationAuthorization() {
  return getTeamAuthorizationContext();
}
