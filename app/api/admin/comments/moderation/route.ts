export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import {
  loadCommunityCommentModerationTarget,
  moderateCommunityComment,
} from "@/lib/comments/commentModeration.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

function errorResponse(error: unknown) {
  const status = getAuthErrorStatus(error) ?? 503;
  return NextResponse.json(
    { error: status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const publicCommentId = new URL(request.url).searchParams.get("comment") ?? "";
    return NextResponse.json(await loadCommunityCommentModerationTarget(publicCommentId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    return NextResponse.json(
      await moderateCommunityComment(await request.json() as Record<string, unknown>),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
