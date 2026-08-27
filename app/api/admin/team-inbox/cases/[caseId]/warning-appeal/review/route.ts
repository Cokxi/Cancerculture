export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import {
  reviewTeamUserWarningAppeal,
  UserWarningAppealConflict,
} from "@/lib/warnings/userWarningAppeal.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const [{ caseId }, body] = await Promise.all([
      context.params,
      request.json() as Promise<Record<string, unknown>>,
    ]);
    const outcome = body.outcome === "overrule" ? "overrule" : body.outcome === "uphold" ? "uphold" : null;
    if (!outcome) return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    const result = await reviewTeamUserWarningAppeal({
      caseId,
      outcome,
      expectedCaseRowVersion: typeof body.expectedCaseRowVersion === "number" ? body.expectedCaseRowVersion : 0,
      expectedCaseWorkVersion: typeof body.expectedCaseWorkVersion === "number" ? body.expectedCaseWorkVersion : 0,
      expectedCaseSourceVersion: typeof body.expectedCaseSourceVersion === "number" ? body.expectedCaseSourceVersion : 0,
      expectedAppealRowVersion: typeof body.expectedAppealRowVersion === "number" ? body.expectedAppealRowVersion : 0,
      expectedWarningRowVersion: typeof body.expectedWarningRowVersion === "number" ? body.expectedWarningRowVersion : 0,
      reason: typeof body.reason === "string" ? body.reason : "",
      requestId: typeof body.requestId === "string" ? body.requestId : "",
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserWarningAppealConflict) {
      return NextResponse.json({ error: error.reason }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json(
      { error: status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
