export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { refundDisqualifiedVotes } from "@/lib/voteRefund/refund.server";
import { parseVoteRefundRequest } from "@/lib/voteRefund/request";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const authorization = await requireDynamicTeamCapability(
      "votes.refund_disqualified"
    );
    const payload = parseVoteRefundRequest(await request.json());
    const result = await refundDisqualifiedVotes({
      actorDiscordUserId: authorization.discord_user_id,
      ...payload,
    });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
