export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorCode, getAuthErrorStatus } from "@/lib/auth/AuthError";
import {
  issueCommunityCommentWarning,
  loadCommunityCommentWarningAccess,
  loadCommunityCommentWarningTarget,
} from "@/lib/comments/commentWarning.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const responseHeaders = { "Cache-Control": "private, no-store" };
const safeConflictCodes = new Set([
  "COMMENT_WARNING_ALREADY_ISSUED",
  "COMMENT_WARNING_IDEMPOTENCY_CONFLICT",
  "COMMENT_WARNING_STALE",
  "COMMENT_WARNING_UNAVAILABLE",
]);

function errorResponse(error: unknown) {
  const status = getAuthErrorStatus(error) ?? 503;
  const code = getAuthErrorCode(error);
  const safeCode = status === 403
    ? "FORBIDDEN"
    : status === 400
      ? "INVALID_INPUT"
      : status === 404
        ? "COMMENT_WARNING_UNAVAILABLE"
        : status === 409 && code && safeConflictCodes.has(code)
          ? code
          : "COMMENT_WARNING_UNAVAILABLE";
  return NextResponse.json(
    { error: safeCode },
    { status, headers: responseHeaders },
  );
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    if (
      searchParams.get("access") === "1" &&
      searchParams.size === 1
    ) {
      return NextResponse.json(
        await loadCommunityCommentWarningAccess(),
        { headers: responseHeaders },
      );
    }
    const publicCommentId = searchParams.get("comment") ?? "";
    return NextResponse.json(
      await loadCommunityCommentWarningTarget(publicCommentId),
      { headers: responseHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    return NextResponse.json(
      await issueCommunityCommentWarning(
        await request.json() as Record<string, unknown>,
      ),
      { headers: responseHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
