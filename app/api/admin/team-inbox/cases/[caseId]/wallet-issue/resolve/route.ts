export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";
import { resolveWalletIssueCase } from "@/lib/walletIssues/service.server";

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const [{ caseId }, body] = await Promise.all([
      context.params,
      request.json() as Promise<Record<string, unknown>>,
    ]);
    const resolution = body.resolution === "accept_correction" || body.resolution === "no_action"
      ? body.resolution
      : "";
    if (!resolution) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    const result = await resolveWalletIssueCase({
      caseId,
      requestId: typeof body.requestId === "string" ? body.requestId : "",
      resolution,
      expectedCaseRowVersion: positiveInteger(body.expectedCaseRowVersion),
      expectedCaseWorkVersion: positiveInteger(body.expectedCaseWorkVersion),
      expectedSourceVersion: positiveInteger(body.expectedSourceVersion),
      expectedIntakeVersion: positiveInteger(body.expectedIntakeVersion),
      expectedClaimVersion: positiveInteger(body.expectedClaimVersion),
      note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    const code = error instanceof Error && error.message === "WINNER_PROFILE_WALLET_OWNER_CONTROLLED"
      ? error.message
      : status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE";
    return NextResponse.json({ error: code }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
