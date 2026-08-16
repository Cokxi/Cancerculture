import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import { AuthError } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";
import { requireTeamAreaAccess } from "@/lib/auth/teamAccess.server";
import {
  hasTeamCapability,
  isAdminTeamRole,
  normalizeTeamRole,
  type CanonicalTeamRole,
  type TeamCapability,
} from "@/lib/auth/teamRoles";

export type TeamMember = {
  discord_user_id: string;
  role: CanonicalTeamRole;
};

export async function getTeamMemberForDiscordUserId(
  discordUserId: string
): Promise<TeamMember> {
  const { data: member, error } = await runAuthQueryWithTimeout(
    "team-member lookup",
    supabaseAdmin
      .from("team_members")
      .select("discord_user_id, role")
      .eq("discord_user_id", discordUserId)
      .maybeSingle()
  );

  if (error) {
    console.error(
      "[ADMIN_AUTH] team-member query Supabase error",
      error
    );
    throw new AuthError(
      503,
      "Admin authorization service temporarily unavailable"
    );
  }

  if (!member) {
    throw new AuthError(403, "Forbidden");
  }

  const role = normalizeTeamRole(member.role);

  if (!role) {
    console.error("[ADMIN_AUTH] invalid team-member role");
    throw new AuthError(
      503,
      "Admin authorization service temporarily unavailable"
    );
  }

  return {
    discord_user_id: member.discord_user_id,
    role,
  };
}

export async function getTeamMember(): Promise<TeamMember> {
  const session = await requireSession();
  const member = await getTeamMemberForDiscordUserId(session.discord_user_id);
  await requireTeamAreaAccess(session);
  return member;
}


export async function requireAdmin(): Promise<TeamMember> {
  const member = await getTeamMember();

  if (!isAdminTeamRole(member.role)) {
    throw new AuthError(403, "Admin only");
  }

  return member;
}

export async function requireTeamCapability(
  capability: TeamCapability,
  deniedMessage = "Forbidden"
): Promise<TeamMember> {
  const member = await getTeamMember();

  if (!hasTeamCapability(member.role, capability)) {
    throw new AuthError(403, deniedMessage);
  }

  return member;
}
