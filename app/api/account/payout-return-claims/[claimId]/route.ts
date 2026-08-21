export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { requireUuid } from "@/lib/payouts/amount";
import { mutateOwnPayoutReturnClaim, PayoutError } from "@/lib/payouts/service.server";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  const gate = enforceRouteMutationGate(); if (gate) return gate;
  try {
    const { claimId } = await context.params; const body = await request.json();
    const action = body?.action;
    if (action !== "confirm" && action !== "decline") throw new Error("PAYOUT_RETURN_CLAIM_INPUT_INVALID");
    const manualRecipient = typeof body.manualRecipient === "string" && body.manualRecipient.trim() ? body.manualRecipient.trim() : null;
    if (manualRecipient && !validateSolRecipientAddress(manualRecipient).ok) throw new Error("PAYOUT_RETURN_CLAIM_INPUT_INVALID");
    const result = await mutateOwnPayoutReturnClaim(await requireSession(), {
      claimPublicId: requireUuid(claimId), requestId: requireUuid(body.requestId), expectedVersion: Number(body.expectedVersion), action, manualRecipient,
    });
    const outcome = String(result.outcome ?? "");
    return NextResponse.json(result, { status: outcome === "not_found" ? 404 : outcome === "state_conflict" ? 409 : outcome === "recipient_invalid" ? 422 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PayoutError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "PAYOUT_RETURN_CLAIM_UNAVAILABLE" }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
