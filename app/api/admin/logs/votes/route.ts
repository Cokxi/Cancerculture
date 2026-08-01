export const runtime = "nodejs";

import { getVoteLogs } from "@/lib/admin/logs";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "logs.votes.view"
    );

    const { data, error } = await getVoteLogs({
      includeRawReason: authorization.isAdmin,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load vote logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      logs: data ?? [],
    });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
