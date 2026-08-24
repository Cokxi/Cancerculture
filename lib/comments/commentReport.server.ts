import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { getCommunityCommentReportDigest } from "@/lib/comments/commentAbuse.server";
import { CommunityCommentServiceError } from "@/lib/comments/commentService.server";
import { parseCommunityCommentReportInput } from "@/lib/comments/commentReportContract";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REPORT_TURNSTILE_MAX_AGE_MS = 5 * 60_000;

export async function submitCommunityCommentReport(input: {
  request: Request;
  sessionId: string;
  reporterDiscordUserId: string;
  publicCommentId: string;
  body: unknown;
}) {
  if (!UUID_PATTERN.test(input.publicCommentId)) {
    throw new CommunityCommentServiceError(400, "COMMENT_REPORT_INVALID");
  }
  const parsed = parseCommunityCommentReportInput(input.body);
  if (!parsed) throw new CommunityCommentServiceError(400, "COMMENT_REPORT_INVALID");

  const verification = await verifyTurnstileRequest(
    input.request,
    TURNSTILE_ACTIONS.communityCommentReport,
    { maxTokenAgeMs: REPORT_TURNSTILE_MAX_AGE_MS },
  );
  if (verification.status === "rejected") {
    throw new CommunityCommentServiceError(400, verification.code);
  }
  if (verification.status !== "verified") {
    throw new CommunityCommentServiceError(503, "TURNSTILE_UNAVAILABLE");
  }

  const requestHash = getCommunityCommentReportDigest({
    reporterDiscordUserId: input.reporterDiscordUserId,
    publicCommentId: input.publicCommentId,
    category: parsed.category,
    explanation: parsed.explanation,
  });
  const { data, error } = await supabaseAdmin.rpc("submit_community_comment_report", {
    p_session_id: input.sessionId,
    p_public_comment_id: input.publicCommentId,
    p_category: parsed.category,
    p_explanation: parsed.explanation,
    p_request_id: parsed.requestId,
    p_request_hash: requestHash,
    p_rules_affirmed: true,
    p_turnstile_verified: true,
  });
  if (error) {
    console.error("[COMMENT_REPORT] RPC failed", { code: error.code });
    throw new CommunityCommentServiceError(503, "COMMENT_REPORT_UNAVAILABLE");
  }
  const result = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  if (result.outcome === "accepted" || result.outcome === "already_reported") {
    return result;
  }
  if (result.outcome === "self_report_forbidden") {
    throw new CommunityCommentServiceError(403, "COMMENT_REPORT_SELF_FORBIDDEN");
  }
  if (result.outcome === "comment_unavailable") {
    throw new CommunityCommentServiceError(404, "COMMENT_NOT_FOUND");
  }
  if (result.outcome === "idempotency_conflict") {
    throw new CommunityCommentServiceError(409, "COMMENT_REPORT_IDEMPOTENCY_CONFLICT");
  }
  if (result.outcome === "rate_limited") {
    const retryAfter = typeof result.retryAfter === "number"
      ? Math.max(1, Math.ceil(result.retryAfter))
      : 1;
    throw new CommunityCommentServiceError(
      429,
      "COMMENT_REPORT_COOLDOWN",
      retryAfter
    );
  }
  if (
    result.outcome === "abuse_configuration_unavailable" ||
    result.outcome === "feature_unavailable"
  ) {
    throw new CommunityCommentServiceError(503, "COMMENT_REPORT_UNAVAILABLE");
  }
  throw new CommunityCommentServiceError(503, "COMMENT_REPORT_UNAVAILABLE");
}
