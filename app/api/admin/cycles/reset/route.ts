export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getAdminApiErrorResponse } from "@/lib/auth/adminApiErrorResponse";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { resetCycleTransactional } from "@/lib/cycles/resetCycle";
import {
  processTargetedR2CleanupQueue,
  verifyR2CleanupQueuePostflight,
} from "@/lib/r2/processMediaCleanupQueue";
import type { MediaCleanupQueuePostflight } from "@/lib/r2/mediaCleanupState";

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
      const result = await processTargetedR2CleanupQueue(
        reset.r2CleanupQueueIds
      );
      let postflight: MediaCleanupQueuePostflight | null = null;

      try {
        postflight = await verifyR2CleanupQueuePostflight(
          reset.r2CleanupQueueIds
        );
      } catch (postflightError) {
        console.error("[cycle reset][media cleanup postflight unavailable]", {
          errorName:
            postflightError instanceof Error
              ? postflightError.name
              : "UnknownError",
        });
      }

      const remainingQueued = postflight
        ? Math.max(
            0,
            postflight.expectedJobs - postflight.completedQueueJobs
          )
        : Math.max(0, reset.r2CleanupQueueIds.length - result.completed);
      const drained =
        result.batchFailures === 0 && postflight?.drained === true;
      cleanup = {
        claimed: result.claimed,
        completed: result.completed,
        retryScheduled: result.retryScheduled,
        terminalFailures: result.terminalFailures,
        staleResults: result.staleResults,
        confirmationFailures: result.confirmationFailures,
        deletionFailures: result.deletionFailures,
        batchesAttempted: result.batchesAttempted,
        batchFailures: result.batchFailures,
        remainingQueued,
        drained,
        postflight,
        warning:
          !drained ||
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
        confirmationFailures: 0,
        deletionFailures: 0,
        batchesAttempted: 0,
        batchFailures: 1,
        remainingQueued: reset.r2CleanupQueueIds.length,
        drained: false,
        postflight: null,
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
