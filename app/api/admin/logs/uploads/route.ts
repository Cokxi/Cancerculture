export const runtime = "nodejs";

import { getUploadLogs } from "@/lib/admin/logs";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "logs.uploads.view"
    );

    const { data, error } = await getUploadLogs({
      includeRawReason: authorization.isAdmin,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load upload logs" },
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
