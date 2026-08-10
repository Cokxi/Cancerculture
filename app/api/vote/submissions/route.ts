export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getSessionState } from "@/lib/auth/sessionState";
import { getCurrentPublicCycle } from "@/lib/cycles/currentCycle";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";
import { getVoteSubmissions } from "@/lib/vote/getVoteSubmissions";

export async function GET(req: Request) {
  try {
    const [activeCycle, sessionState] = await Promise.all([
      getCurrentPublicCycle(),
      getSessionState(),
    ]);

    if (sessionState.status === "dependency_unavailable") {
      return NextResponse.json(
        { error: "Viewer state temporarily unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

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
      viewerDiscordUserId:
        sessionState.status === "authenticated"
          ? sessionState.session.discord_user_id
          : null,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}
