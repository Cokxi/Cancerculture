export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSubmissionModerationLogs } from "@/lib/admin/moderationLogs";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";

export async function GET() {
  try {
    const authorization = await requireDynamicTeamCapability(
      "logs.submission_moderation.view"
    );

    const { data, error } = await getSubmissionModerationLogs({
      includeAdminDetails: authorization.isAdmin,
    });

    if (error) {
      return NextResponse.json(
        { error: "Failed to load moderation logs" },
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
