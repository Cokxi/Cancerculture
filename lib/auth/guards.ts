import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import { AuthError } from "@/lib/auth/AuthError";
import { runAuthQueryWithTimeout } from "@/lib/auth/authQuery";

type TeamMember = {
  discord_user_id: string;
  role: "admin" | "mod";
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

  if (member.role !== "admin" && member.role !== "mod") {
    console.error("[ADMIN_AUTH] invalid team-member role", member);
    throw new AuthError(
      503,
      "Admin authorization service temporarily unavailable"
    );
  }

  return member as TeamMember;
}

export async function getTeamMember(): Promise<TeamMember> {
  const session = await requireSession();
  return getTeamMemberForDiscordUserId(session.discord_user_id);
}


export async function requireAdmin(): Promise<TeamMember> {
  const member = await getTeamMember();

  if (member.role !== "admin") {
    throw new AuthError(403, "Admin only");
  }

  return member;
}


export async function requireModOrAdmin(): Promise<TeamMember> {
  const member = await getTeamMember();

  if (member.role !== "admin" && member.role !== "mod") {
    throw new AuthError(403, "Forbidden");
  }

  return member;
}
