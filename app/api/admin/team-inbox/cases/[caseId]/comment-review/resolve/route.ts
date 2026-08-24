export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { resolveCommunityCommentReviewCase } from "@/lib/comments/commentModeration.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> },
) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const [{ caseId }, body] = await Promise.all([
      context.params,
      request.json() as Promise<Record<string, unknown>>,
    ]);
    return NextResponse.json(await resolveCommunityCommentReviewCase({
      ...body,
      caseId,
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE" },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
