export const runtime = "nodejs";

import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import {
  CyclePrizePoolError,
  saveCurrentCyclePrizePool,
} from "@/lib/cycles/prizePool.server";
import {
  parseNonnegativeInteger,
  parsePositiveInteger,
  parseSolToLamports,
  requireUuid,
} from "@/lib/payouts/amount";
import { NextResponse } from "next/server";

const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const body = await request.json().catch(() => null);
    const amount =
      typeof body?.amountSol === "string" ? body.amountSol.trim() : "";
    const confirmation =
      typeof body?.confirmedAmountSol === "string"
        ? body.confirmedAmountSol.trim()
        : "";

    if (!amount || amount !== confirmation) {
      return NextResponse.json(
        {
          error: "Enter the exact same SOL amount in both fields.",
          code: "CONFIRMATION_INVALID",
        },
        { status: 400, headers }
      );
    }

    const amountLamports = parseSolToLamports(amount);
    const confirmedAmountLamports = parseSolToLamports(confirmation);
    const result = await saveCurrentCyclePrizePool({
      actorDiscordUserId: authorization.discord_user_id,
      requestId: requireUuid(body?.requestId, "INVALID_REQUEST"),
      cycleId: parsePositiveInteger(body?.cycleId, "INVALID_CYCLE"),
      expectedVersion: parseNonnegativeInteger(
        body?.expectedVersion,
        "INVALID_VERSION"
      ),
      amountLamports,
      confirmedAmountLamports,
    });

    return NextResponse.json(result, { headers });
  } catch (error) {
    const authStatus = getAuthErrorStatus(error);
    const status =
      error instanceof CyclePrizePoolError
        ? error.status
        : authStatus ??
          (error instanceof Error &&
          [
            "PAYOUT_AMOUNT_INVALID",
            "INVALID_REQUEST",
            "INVALID_CYCLE",
            "INVALID_VERSION",
          ].includes(error.message)
            ? 400
            : 500);
    const message =
      error instanceof CyclePrizePoolError
        ? error.message
        : status === 400
          ? "Enter a valid positive SOL amount."
          : status === 403
            ? "Forbidden"
            : "Prize pool management is temporarily unavailable.";
    const code =
      error instanceof CyclePrizePoolError
        ? error.code
        : status === 400
          ? "INVALID_INPUT"
          : status === 403
            ? "FORBIDDEN"
            : "UNAVAILABLE";

    if (status >= 500) {
      console.error("[cycle prize pool][route]", error);
    }
    return NextResponse.json({ error: message, code }, { status, headers });
  }
}
