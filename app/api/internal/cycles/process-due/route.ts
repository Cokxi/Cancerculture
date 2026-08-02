export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authorizeCycleAutomationTrigger } from "@/lib/auth/cycleAutomationTriggerAuth";
import {
  beginCycleSchedulerRun,
  finishCycleSchedulerRun,
} from "@/lib/cycles/cycleSchedulerRunHealth";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const SCHEDULER_RUN_ID_HEADER = "x-cc-scheduler-run-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  const authorization = authorizeCycleAutomationTrigger({
    authorizationHeader: req.headers.get("authorization"),
    configuredSecret: process.env.CYCLE_AUTOMATION_TRIGGER_SECRET,
  });

  if (authorization === "misconfigured") {
    return NextResponse.json(
      { error: "Cycle automation trigger is unavailable" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  if (authorization !== "authorized") {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const runId = req.headers.get(SCHEDULER_RUN_ID_HEADER);
  if (!runId || !UUID_PATTERN.test(runId)) {
    return NextResponse.json(
      { error: "Invalid scheduler run ID" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const schedulerRun = await beginCycleSchedulerRun(runId);
    if (schedulerRun.outcome === "replay") {
      return NextResponse.json(
        {
          success: true,
          runId,
          result: {
            outcome: "noop",
            cycleId: null,
            previousStatus: null,
            status: null,
            transition: null,
            reason: "scheduler_run_replay",
            repairCodes: [],
            eventCreated: false,
            processedAt: new Date().toISOString(),
          },
        },
        { headers: NO_STORE_HEADERS }
      );
    }

    const result = await processDueCycleTransitions();
    await finishCycleSchedulerRun({
      runId,
      succeeded: true,
      outcome: result.outcome,
    });

    return NextResponse.json(
      {
        success: true,
        runId,
        result: {
          outcome: result.outcome,
          cycleId: result.cycleId,
          status: result.status,
          transition: result.transition,
          reason: result.reason,
          repaired: result.repairCodes.length > 0,
        },
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    try {
      await finishCycleSchedulerRun({
        runId,
        succeeded: false,
        outcome: "failed",
      });
    } catch {
      console.error("[internal cycle automation] health recording failed");
    }
    console.error("[internal cycle automation] processing failed", {
      errorName:
        error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Cycle automation failed" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
}
