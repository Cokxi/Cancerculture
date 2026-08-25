export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { markAllOwnMentionsViewed } from "@/lib/comments/commentOwner.server";
import { requireSameOrigin, SameOriginError } from "@/lib/http/requireSameOrigin";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    requireSameOrigin(request);
    const session = await requireSession();
    const candidate = await request.json().catch(() => null);
    const body = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : {};
    if (
      Object.keys(body).length !== 2 ||
      !("snapshotAt" in body) || !("requestId" in body) ||
      typeof body.snapshotAt !== "string" || typeof body.requestId !== "string"
    ) {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400, headers });
    }
    return NextResponse.json(await markAllOwnMentionsViewed({
      sessionId: session.session_id,
      snapshotAt: body.snapshotAt,
      requestId: body.requestId,
    }), { headers });
  } catch (error) {
    if (error instanceof SameOriginError) {
      return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403, headers });
    }
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 401 ? "NOT_AUTHENTICATED" : "MENTIONS_UNAVAILABLE" }, { status, headers });
  }
}
