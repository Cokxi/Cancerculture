export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { resetCycleTransactional } from "@/lib/cycles/resetCycle";
import { processR2CleanupQueue } from "@/lib/r2/processMediaCleanupQueue";

const MAX_REASON_LENGTH = 1000;

export async function POST(req: Request) {
  try {
    const authorization =
      await requireDynamicTeamCapability("cycles.manage");
    const body = await req.json().catch(() => null);
    const cycleId = Number(body?.cycleId);
    const reason =
      typeof body?.reason === "string" ? body.reason.trim() : "";
    const confirmation =
      typeof body?.confirmation === "string"
        ? body.confirmation.trim()
        : "";

    if (!Number.isSafeInteger(cycleId) || cycleId <= 0) {
      return NextResponse.json(
        { error: "Invalid cycle id" },
        { status: 400 }
      );
    }

    if (!reason) {
      return NextResponse.json(
        { error: "A reset reason is required" },
        { status: 400 }
      );
    }

    if (reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: "Reset reason is too long" },
        { status: 400 }
      );
    }

    if (confirmation !== `RESET ${cycleId}`) {
      return NextResponse.json(
        { error: `Type RESET ${cycleId} to confirm` },
        { status: 400 }
      );
    }

    const reset = await resetCycleTransactional({
      actorDiscordUserId: authorization.discord_user_id,
      cycleId,
      reason,
    });
    let cleanup;

    try {
      const targetedQueueIds = reset.r2CleanupQueueIds.slice(0, 20);
      const result = targetedQueueIds.length > 0
        ? await processR2CleanupQueue({ queueIds: targetedQueueIds })
        : {
            claimed: 0,
            completed: 0,
            retryScheduled: 0,
            terminalFailures: 0,
            staleResults: 0,
            confirmationFailures: 0,
          };
      const remainingQueued = Math.max(
        0,
        reset.r2CleanupQueueIds.length - result.completed
      );
      cleanup = {
        claimed: result.claimed,
        completed: result.completed,
        retryScheduled: result.retryScheduled,
        terminalFailures: result.terminalFailures,
        staleResults: result.staleResults,
        remainingQueued,
        warning:
          remainingQueued > 0 ||
          result.retryScheduled > 0 ||
          result.terminalFailures > 0 ||
          result.staleResults > 0 ||
          result.confirmationFailures > 0
            ? "Cycle reset succeeded, but some cycle media cleanup remains queued or requires review."
            : null,
      };
    } catch (cleanupError) {
      console.error("[cycle reset][media cleanup unavailable]", {
        errorName:
          cleanupError instanceof Error
            ? cleanupError.name
            : "UnknownError",
      });
      cleanup = {
        claimed: 0,
        completed: 0,
        retryScheduled: 0,
        terminalFailures: 0,
        staleResults: 0,
        remainingQueued: reset.r2CleanupQueueIds.length,
        warning:
          "Cycle reset succeeded, but queued media cleanup could not be started.",
      };
    }

    return NextResponse.json({
      success: true,
      reset: {
        cycleId: reset.cycleId,
        cycleNumber: reset.cycleNumber,
        previousStatus: reset.previousStatus,
        status: reset.status,
        removedSubmissions: reset.removedSubmissions,
        removedVotes: reset.removedVotes,
        affectedSubmitters: reset.affectedSubmitters,
        removedResults: reset.removedResults,
        removedWinnerRows: reset.removedWinnerRows,
        r2KeysPendingCleanup: reset.r2KeysPendingCleanup,
        alreadyReset: reset.alreadyReset,
        resetCount: reset.resetCount,
      },
      cleanup,
    });
  } catch (error) {
    return getAdminApiErrorResponse(
      error,
      "POST /api/admin/cycles/reset"
    );
  }
}
