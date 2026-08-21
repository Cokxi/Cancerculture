export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { requireUuid } from "@/lib/payouts/amount";
import { disqualifyPayoutAllocation, PayoutError } from "@/lib/payouts/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ allocationId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
    const { allocationId } = await context.params;
    const body = await request.json();
    const reason = typeof body?.publicReason === "string" ? body.publicReason.trim() : "";
    if (reason.length < 3 || reason.length > 500) throw new Error("A clear public reason between 3 and 500 characters is required.");
    const result = await disqualifyPayoutAllocation(authorization.discord_user_id, {
      requestId: requireUuid(body?.requestId),
      allocationPublicId: requireUuid(allocationId),
      publicReason: reason,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PayoutError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "The payout could not be blocked." }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
