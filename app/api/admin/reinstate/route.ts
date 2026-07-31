export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { moderateSubmission } from "@/lib/moderation/moderateSubmission";
import { requireSubmissionModerationAction } from "@/lib/moderation/submissionModerationAuthorization";
import { parseSubmissionModerationRequest } from "@/lib/moderation/submissionModerationRequest";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const authorization = await getTeamAuthorizationContext();
    const payload = parseSubmissionModerationRequest(
      await req.json(),
      "reinstate"
    );
    requireSubmissionModerationAction(
      authorization,
      payload.expectedPhase,
      payload.operation
    );
    const result = await moderateSubmission({
      actorDiscordUserId: authorization.discord_user_id,
      ...payload,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
