export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { mutateTeamInboxCase } from "@/lib/teamInbox/teamInbox.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const [{ caseId }, body] = await Promise.all([
      context.params,
      request.json() as Promise<Record<string, unknown>>,
    ]);
    const result = await mutateTeamInboxCase({
      caseId,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      action: typeof body.action === "string" ? body.action : "",
      expectedState: typeof body.expectedState === "string" ? body.expectedState : "",
      expectedRowVersion: typeof body.expectedRowVersion === "number" ? body.expectedRowVersion : 0,
      expectedWorkVersion: typeof body.expectedWorkVersion === "number" ? body.expectedWorkVersion : 0,
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 403 ? "FORBIDDEN" : status === 400 ? "INVALID_INPUT" : "UNAVAILABLE" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
