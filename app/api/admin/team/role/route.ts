export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guards";
import {
  changeTeamMemberRole,
  TeamRoleChangeError,
} from "@/lib/auth/changeTeamMemberRole";
import {
  parseTeamRoleChangePayload,
  TeamRolePayloadError,
} from "@/lib/auth/teamRoleChangePayload";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const payload = parseTeamRoleChangePayload(
      await req.json().catch(() => null)
    );
    const result = await changeTeamMemberRole({
      actorDiscordUserId: admin.discord_user_id,
      targetDiscordUserId: payload.targetDiscordId,
      targetRole: payload.targetRole,
      reason: payload.reason,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (
      error instanceof TeamRolePayloadError ||
      error instanceof TeamRoleChangeError
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    const authStatus = getAuthErrorStatus(error);

    if (authStatus === 401 || authStatus === 403) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Forbidden",
        },
        { status: authStatus }
      );
    }

    console.error("[team-role] update failed", error);
    return NextResponse.json(
      { error: "Failed to update team role" },
      { status: 500 }
    );
  }
}
