export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getTeamMember } from "@/lib/auth/guards";
import { getCycleHistoryCycleData } from "@/lib/cycles/getCycleHistoryData";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET(
  _req: Request,
  context: {
    params: Promise<{ cycleId: string }>;
  }
) {
  try {
    let isAdminView = false;

    try {
      const member = await getTeamMember();
      isAdminView = member.role === "admin";
    } catch {}

    const { cycleId: cycleIdRaw } = await context.params;
    const cycleId = Number(cycleIdRaw);

    if (!Number.isInteger(cycleId)) {
      return NextResponse.json(
        { error: "Invalid cycle id" },
        { status: 400 }
      );
    }

    const cycle = await getCycleHistoryCycleData(cycleId, {
      isAdminView,
    });

    if (!cycle) {
      return NextResponse.json(
        { error: "Cycle not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ cycle });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
