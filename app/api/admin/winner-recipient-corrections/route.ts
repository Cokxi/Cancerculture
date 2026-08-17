export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { validateSolRecipientAddress } from "@/lib/solana/address";
import {
  manageWinnerRecipientCorrection,
  WinnerClaimError,
} from "@/lib/winnerClaims/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";
import { NextResponse } from "next/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function POST(request: Request) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;

  try {
    await requireDynamicTeamCapability("winners.payouts.view");
    const authorization = await requireDynamicTeamCapability(
      "winners.recipient_corrections.manage"
    );
    const body = await request.json();
    const proposedAddress =
      typeof body?.proposedRecipient === "string"
        ? body.proposedRecipient.trim()
        : null;
    const validation =
      proposedAddress
        ? validateSolRecipientAddress(proposedAddress)
        : null;

    if (
      typeof body?.requestId !== "string" ||
      !UUID_PATTERN.test(body.requestId) ||
      typeof body?.claimId !== "string" ||
      !UUID_PATTERN.test(body.claimId) ||
      !Number.isSafeInteger(body?.expectedClaimVersion) ||
      body.expectedClaimVersion <= 0 ||
      validation?.ok !== true
    ) {
      throw new WinnerClaimError(400, "WINNER_CORRECTION_INPUT_INVALID");
    }

    const result = await manageWinnerRecipientCorrection({
      actorDiscordUserId: authorization.discord_user_id,
      requestId: body.requestId,
      claimId: body.claimId,
      expectedClaimVersion: body.expectedClaimVersion,
      proposedRecipient: validation.address,
    });
    const outcome = typeof result.outcome === "string" ? result.outcome : "";
    const status =
      outcome === "not_found" ? 404 :
      ["claim_stale", "state_conflict"].includes(outcome) ? 409 :
      outcome === "not_manual_recipient" ? 422 : 200;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof WinnerClaimError) {
      return NextResponse.json(
        { error: error.code },
        { status: error.status, headers: { "Cache-Control": "no-store" } }
      );
    }
    return getRouteErrorResponse(error);
  }
}
