export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getTeamMember } from "@/lib/auth/guards";
import { getCycleHistorySummariesPage } from "@/lib/cycles/getCycleHistoryData";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";

export async function GET(req: Request) {
  try {
    let isAdminView = false;

    try {
      const member = await getTeamMember();
      isAdminView = member.role === "admin";
    } catch {}

    const cursor = new URL(req.url).searchParams.get("cursor");
    const page = await getCycleHistorySummariesPage({
      cursor,
      isAdminView,
    });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}

