export const runtime = "nodejs";

import { getAvatarUploadLogs } from "@/lib/admin/logs";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "logs.avatar_uploads.view"
    );

    const { data, error } = await getAvatarUploadLogs({
      includeAdminDetails: authorization.isAdmin,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load avatar upload logs" },
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
