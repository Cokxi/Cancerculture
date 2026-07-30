import "server-only";

import type { CanonicalTeamRole } from "@/lib/auth/teamRoles";
import { supabaseAdmin } from "@/lib/db/admin";

type ChangeTeamMemberRoleParams = {
  actorDiscordUserId: string;
  targetDiscordUserId: string;
  targetRole: CanonicalTeamRole | null;
  reason: string;
};

export type ChangeTeamMemberRoleResult = {
  changed: boolean;
  previousRole: CanonicalTeamRole | null;
  newRole: CanonicalTeamRole | null;
};

export class TeamRoleChangeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function mapDatabaseError(error: { message?: string }) {
  const message = error.message ?? "";

  if (message.includes("ACTOR_NOT_ADMIN")) {
    return new TeamRoleChangeError(403, "Admin only");
  }

  if (message.includes("TARGET_USER_NOT_FOUND")) {
    return new TeamRoleChangeError(
      404,
      "Target user not found"
    );
  }

  if (message.includes("LAST_ADMIN_PROTECTED")) {
    return new TeamRoleChangeError(
      409,
      "The last admin cannot be removed or demoted"
    );
  }

  if (
    message.includes("INVALID_TEAM_ROLE") ||
    message.includes("REASON_REQUIRED")
  ) {
    return new TeamRoleChangeError(
      400,
      message.includes("REASON_REQUIRED")
        ? "Reason is required"
        : "Invalid target role"
    );
  }

  return new TeamRoleChangeError(
    500,
    "Failed to update team role"
  );
}

export async function changeTeamMemberRole({
  actorDiscordUserId,
  targetDiscordUserId,
  targetRole,
  reason,
}: ChangeTeamMemberRoleParams): Promise<ChangeTeamMemberRoleResult> {
  const { data, error } = await supabaseAdmin.rpc(
    "set_team_member_role",
    {
      p_actor_discord_user_id: actorDiscordUserId,
      p_target_discord_user_id: targetDiscordUserId,
      p_new_role: targetRole,
      p_reason: reason,
    }
  );

  if (error) {
    throw mapDatabaseError(error);
  }

  if (
    !data ||
    typeof data !== "object" ||
    typeof data.changed !== "boolean"
  ) {
    throw new TeamRoleChangeError(
      500,
      "Invalid role update response"
    );
  }

  return {
    changed: data.changed,
    previousRole:
      typeof data.previousRole === "string"
        ? (data.previousRole as CanonicalTeamRole)
        : null,
    newRole:
      typeof data.newRole === "string"
        ? (data.newRole as CanonicalTeamRole)
        : null,
  };
}
