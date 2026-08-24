export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireAdmin } from "@/lib/auth/guards";
import { requireSession } from "@/lib/auth/requireSession";
import {
  COMMUNITY_COMMENT_POLICY_ACTIONS,
  CommunityCommentPolicyManagementError,
  getCommunityCommentPolicyManagement,
  manageCommunityCommentAbusePolicy,
  manageCommunityCommentReleaseState,
  manageCommunityCommentSpamPolicy,
  type CommunityCommentPolicyAction,
  type CommunityCommentReleaseState,
} from "@/lib/comments/commentPolicyManagement.server";
import { requireSameOrigin, SameOriginError } from "@/lib/http/requireSameOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache" };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function policyAction(value: unknown): value is CommunityCommentPolicyAction {
  return COMMUNITY_COMMENT_POLICY_ACTIONS.includes(value as CommunityCommentPolicyAction);
}

function optionalInteger(value: unknown, allowZero = false): number | null | undefined {
  if (value === null) return null;
  if ((allowZero ? nonnegativeInteger(value) : positiveInteger(value))) return Number(value);
  return undefined;
}

function signalWeights(value: unknown): Readonly<Record<string, number>> | null | undefined {
  if (value === null) return null;
  const input = record(value);
  if (Object.keys(input).length === 0) return undefined;
  const output: Record<string, number> = {};
  for (const [key, weight] of Object.entries(input)) {
    if (!positiveInteger(weight)) return undefined;
    output[key] = weight;
  }
  return output;
}

async function ownerSessionId() {
  await requireAdmin();
  return (await requireSession()).session_id;
}

export async function GET() {
  try {
    const data = await getCommunityCommentPolicyManagement(await ownerSessionId());
    return NextResponse.json(data, { headers });
  } catch (error) {
    return policyError(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const sessionId = await ownerSessionId();
    const body = record(await request.json().catch(() => null));
    if (body.operation === "release_state") {
      if (!exactKeys(body, ["operation", "releaseState", "expectedVersion", "requestId"])) {
        throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment release input.");
      }
      if (
        !["off", "read_only", "open"].includes(String(body.releaseState)) ||
        !positiveInteger(body.expectedVersion) ||
        !requestId(body.requestId)
      ) throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment release input.");
      const result = await manageCommunityCommentReleaseState({
        sessionId,
        releaseState: body.releaseState as CommunityCommentReleaseState,
        expectedVersion: body.expectedVersion,
        requestId: body.requestId,
      });
      return NextResponse.json(result, { headers });
    }
    if (body.operation === "abuse_policy") {
      if (!exactKeys(body, [
        "operation", "action", "expectedStateVersion", "active", "windowSeconds",
        "maxActions", "cooldownSeconds", "turnstileAfter", "requestId",
      ])) throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment action policy input.");
      const windowSeconds = optionalInteger(body.windowSeconds);
      const maxActions = optionalInteger(body.maxActions);
      const cooldownSeconds = optionalInteger(body.cooldownSeconds);
      const turnstileAfter = optionalInteger(body.turnstileAfter, true);
      if (
        !policyAction(body.action) || !positiveInteger(body.expectedStateVersion) ||
        typeof body.active !== "boolean" || windowSeconds === undefined ||
        maxActions === undefined || cooldownSeconds === undefined ||
        turnstileAfter === undefined || !requestId(body.requestId) ||
        (body.active && (
          windowSeconds === null || maxActions === null ||
          cooldownSeconds === null || turnstileAfter === null
        )) ||
        (!body.active && (
          windowSeconds !== null || maxActions !== null ||
          cooldownSeconds !== null || turnstileAfter !== null
        ))
      ) throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment action policy input.");
      const result = await manageCommunityCommentAbusePolicy({
        sessionId,
        action: body.action,
        expectedStateVersion: body.expectedStateVersion,
        active: body.active,
        windowSeconds,
        maxActions,
        cooldownSeconds,
        turnstileAfter,
        requestId: body.requestId,
      });
      return NextResponse.json(result, { headers });
    }
    if (body.operation === "spam_policy") {
      if (!exactKeys(body, [
        "operation", "expectedStateVersion", "active", "minimumEventCount",
        "lookbackSeconds", "thresholdScore", "signalWeights", "requestId",
      ])) throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Spam Review policy input.");
      const minimumEventCount = optionalInteger(body.minimumEventCount);
      const lookbackSeconds = optionalInteger(body.lookbackSeconds);
      const thresholdScore = optionalInteger(body.thresholdScore);
      const weights = signalWeights(body.signalWeights);
      if (
        !positiveInteger(body.expectedStateVersion) || typeof body.active !== "boolean" ||
        minimumEventCount === undefined || lookbackSeconds === undefined ||
        thresholdScore === undefined || weights === undefined || !requestId(body.requestId) ||
        (body.active && (
          minimumEventCount === null || lookbackSeconds === null ||
          thresholdScore === null || weights === null
        )) ||
        (!body.active && (
          minimumEventCount !== null || lookbackSeconds !== null ||
          thresholdScore !== null || weights !== null
        ))
      ) throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Spam Review policy input.");
      const result = await manageCommunityCommentSpamPolicy({
        sessionId,
        expectedStateVersion: body.expectedStateVersion,
        active: body.active,
        minimumEventCount,
        lookbackSeconds,
        thresholdScore,
        signalWeights: weights,
        requestId: body.requestId,
      });
      return NextResponse.json(result, { headers });
    }
    throw new CommunityCommentPolicyManagementError(400, "INVALID_INPUT", "Invalid Comment policy operation.");
  } catch (error) {
    return policyError(error);
  }
}

function policyError(error: unknown) {
  if (error instanceof CommunityCommentPolicyManagementError || error instanceof SameOriginError) {
    return NextResponse.json(
      { error: error.message, code: error instanceof CommunityCommentPolicyManagementError ? error.code : "INVALID_ORIGIN" },
      { status: error.status, headers }
    );
  }
  const status = getAuthErrorStatus(error);
  if (status === 401 || status === 403) {
    return NextResponse.json(
      { error: status === 401 ? "Authentication required" : "Owner access required", code: status === 401 ? "NOT_AUTHENTICATED" : "OWNER_REQUIRED" },
      { status, headers }
    );
  }
  console.error("[COMMENT_POLICY] route failure", { name: error instanceof Error ? error.name : "unknown" });
  return NextResponse.json(
    { error: "Comment policy management is temporarily unavailable.", code: "UNAVAILABLE" },
    { status: 503, headers }
  );
}
