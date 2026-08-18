export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { loadTeamInboxCaseDetail } from "@/lib/teamInbox/teamInbox.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(_request: Request, context: { params: Promise<{ caseId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const { caseId } = await context.params;
    return NextResponse.json(await loadTeamInboxCaseDetail(caseId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 403 ? "FORBIDDEN" : "UNAVAILABLE" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
