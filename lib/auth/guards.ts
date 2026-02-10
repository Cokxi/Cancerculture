import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";

type TeamMember = {
  discord_user_id: string;
  role: "admin" | "mod";
};

class AuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Holt den eingeloggten Team-Member
 * Session-basiert. Discord-only. Kein Fallback.
 */
export async function getTeamMember(): Promise<TeamMember> {
  let discordUserId: string;

  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    throw new AuthError(401, "Unauthorized");
  }

  const { data: member, error } = await supabaseAdmin
    .from("team_members")
    .select("discord_user_id, role")
    .eq("discord_user_id", discordUserId)
    .single();

  if (error || !member) {
    throw new AuthError(403, "Forbidden");
  }

  return member;
}

/**
 * ADMIN ONLY
 */
export async function requireAdmin(): Promise<TeamMember> {
  const member = await getTeamMember();

  if (member.role !== "admin") {
    throw new AuthError(403, "Admin only");
  }

  return member;
}

/**
 * MOD oder ADMIN
 */
export async function requireModOrAdmin(): Promise<TeamMember> {
  const member = await getTeamMember();

  if (member.role !== "admin" && member.role !== "mod") {
    throw new AuthError(403, "Forbidden");
  }

  return member;
}
