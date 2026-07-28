export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getTeamMember } from "@/lib/auth/guards";
import { getCycleHistorySubmissionPage } from "@/lib/cycles/getCycleHistoryData";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";

export async function GET(
  req: Request,
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

    if (!Number.isSafeInteger(cycleId) || cycleId <= 0) {
      return NextResponse.json(
        { error: "Invalid cycle id" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const cursor = new URL(req.url).searchParams.get("cursor");
    const page = await getCycleHistorySubmissionPage({
      cursor,
      cycleId,
      isAdminView,
    });

    if (!page) {
      return NextResponse.json(
        { error: "Cycle not found" },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}
