export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { AuthError } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import {
  mutateOwnWinnerClaim,
  WinnerClaimError,
  type WinnerClaimAction,
} from "@/lib/winnerClaims/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";
import { NextResponse } from "next/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION_PATTERN = /^[0-9a-f]{32}$/u;

function errorResponse(error: unknown) {
  if (error instanceof WinnerClaimError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (error instanceof AuthError) return getRouteErrorResponse(error);
  return NextResponse.json(
    { error: "WINNER_CLAIM_UNAVAILABLE" },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ claimId: string }> }
) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  try {
    const { claimId } = await context.params;
    const body = await request.json();
    const action = body?.action as WinnerClaimAction;
    const revision = body?.expectedCandidateRevision;
    if (
      !UUID_PATTERN.test(claimId) ||
      typeof body?.requestId !== "string" ||
      !UUID_PATTERN.test(body.requestId) ||
      !["confirm", "decline"].includes(action) ||
      (revision !== null &&
        (typeof revision !== "string" || !REVISION_PATTERN.test(revision))) ||
      typeof body?.acknowledged !== "boolean" ||
      (action !== "decline" && revision === null)
    ) {
      throw new WinnerClaimError(400, "WINNER_CLAIM_INPUT_INVALID");
    }

    const result = await mutateOwnWinnerClaim({
      session: await requireSession(),
      claimId,
      requestId: body.requestId,
      action,
      expectedCandidateRevision: revision,
      acknowledged: body.acknowledged,
    });
    const outcome = typeof result.outcome === "string" ? result.outcome : "";
    const status =
      outcome === "not_found" ? 404 :
      outcome === "candidate_stale" || outcome === "state_conflict" ? 409 :
      outcome === "recipient_unavailable" ? 503 : 200;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
