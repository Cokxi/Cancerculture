export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { getCurrentPublicCycle } from "@/lib/cycles/currentCycle";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import {
  getVoteSubmissions,
  VOTE_SUBMISSIONS_PAGE_SIZE,
} from "@/lib/vote/getVoteSubmissions";

export async function GET(req: Request) {
  try {
    await requireSession();

    const activeCycle = await getCurrentPublicCycle();

    if (!activeCycle) {
      return NextResponse.json(
        { error: "No active cycle" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const cycleId = Number(
      searchParams.get("cycleId") ?? activeCycle.id
    );
    const offset = Number(searchParams.get("offset") ?? 0);
    const limit = Number(
      searchParams.get("limit") ?? VOTE_SUBMISSIONS_PAGE_SIZE
    );

    if (
      !Number.isInteger(cycleId) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      return NextResponse.json(
        { error: "Invalid pagination parameters" },
        { status: 400 }
      );
    }

    if (cycleId !== activeCycle.id) {
      return NextResponse.json(
        { error: "Cycle mismatch" },
        { status: 400 }
      );
    }

    const result = await getVoteSubmissions({
      cycleId,
      offset,
      limit,
    });

    return NextResponse.json(result);
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
