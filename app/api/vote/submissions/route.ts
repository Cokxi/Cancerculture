export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCurrentPublicCycle } from "@/lib/cycles/currentCycle";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";
import { getVoteSubmissions } from "@/lib/vote/getVoteSubmissions";

export async function GET(req: Request) {
  try {
    const activeCycle = await getCurrentPublicCycle();

    if (!activeCycle) {
      return NextResponse.json(
        { error: "No active cycle" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const { searchParams } = new URL(req.url);
    const cycleId = Number(
      searchParams.get("cycleId") ?? activeCycle.id
    );
    const cursor = searchParams.get("cursor");

    if (
      !Number.isSafeInteger(cycleId) ||
      cycleId <= 0
    ) {
      return NextResponse.json(
        { error: "INVALID_CYCLE_ID" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    if (cycleId !== activeCycle.id) {
      return NextResponse.json(
        { error: "Cycle mismatch" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const result = await getVoteSubmissions({
      cycleId,
      cursor,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}
