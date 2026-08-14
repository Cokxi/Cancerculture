export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authorizeInternalTrigger } from "@/lib/auth/internalTriggerAuth";
import {
  isMatchingMediaCleanupEnvironment,
  MEDIA_CLEANUP_ENVIRONMENT_HEADER,
  resolveWebsiteMediaCleanupEnvironment,
} from "@/lib/r2/mediaCleanupEnvironment";
import {
  getMediaCleanupQueueHealth,
  processDueR2CleanupQueue,
} from "@/lib/r2/processMediaCleanupQueue";
import { pruneSponsorMeasurementRetention } from "@/lib/sponsors/retention.server";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function POST(req: Request) {
  const authorization = authorizeInternalTrigger({
    authorizationHeader: req.headers.get("authorization"),
    configuredSecret: process.env.MEDIA_CLEANUP_TRIGGER_SECRET,
  });

  if (authorization === "misconfigured") {
    return NextResponse.json(
      { error: "Media cleanup trigger is unavailable" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  if (authorization !== "authorized") {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const environment = resolveWebsiteMediaCleanupEnvironment(
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );
  if (
    !isMatchingMediaCleanupEnvironment({
      requested: req.headers.get(MEDIA_CLEANUP_ENVIRONMENT_HEADER),
      website: environment,
    })
  ) {
    return NextResponse.json(
      { error: "Media cleanup trigger is unavailable" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await processDueR2CleanupQueue();
    const sponsorRetention = await pruneSponsorMeasurementRetention();
    const queue = await getMediaCleanupQueueHealth();
    const dueDrained =
      queue.dueRetryPending === 0 && queue.expiredProcessing === 0;

    return NextResponse.json(
      {
        environment,
        claimed: result.claimed,
        completed: result.completed,
        recoveredUploads: result.recoveredUploads,
        queuedFromRecovery: result.queuedFromRecovery,
        retryScheduled: result.retryScheduled,
        terminalFailures: result.terminalFailures,
        staleResults: result.staleResults,
        confirmationFailures: result.confirmationFailures,
        deletionFailures: result.deletionFailures,
        batchesAttempted: result.batchesAttempted,
        batchLimitReached: !result.drainComplete,
        dueDrained,
        fullyDrained: queue.outstanding === 0,
        sponsorRetention,
        queue,
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("[internal media cleanup] processing failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Media cleanup failed" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
}
