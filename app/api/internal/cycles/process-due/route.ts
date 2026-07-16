export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { authorizeCycleAutomationTrigger } from "@/lib/auth/cycleAutomationTriggerAuth";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

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

  try {
    const result = await processDueCycleTransitions();

    return NextResponse.json(
      {
        success: true,
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
