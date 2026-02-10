"use server";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function banUser(params: {
  targetDiscordUserId: string;
  reason: string;
  source?: "illegal_submission" | "admin_manual";
}) {
  const { targetDiscordUserId, reason, source } = params;

  if (!reason?.trim()) {
    throw new Error("Ban reason is required");
  }

  const admin = await requireAdmin();
  const adminDiscordId = admin.discord_user_id;

  const { data: adminLog } = await supabaseAdmin
    .from("user_logs")
    .select("current_discord_username")
    .eq("discord_user_id", adminDiscordId)
    .single();

  const adminUsername = adminLog?.current_discord_username ?? null;

  const { data: targetUser } = await supabaseAdmin
    .from("user_logs")
    .select("is_banned")
    .eq("discord_user_id", targetDiscordUserId)
    .single();

  if (targetUser?.is_banned) {
    throw new Error("User already banned");
  }

  const { error } = await supabaseAdmin
    .from("user_logs")
    .update({
      is_banned: true,
      ban_reason: reason,
      ban_source: source ?? "admin_manual",
      banned_at: new Date().toISOString(),
      banned_by_discord_user_id: adminDiscordId,
      banned_by_discord_username: adminUsername,
    })
    .eq("discord_user_id", targetDiscordUserId);

  if (error) throw error;

  return { success: true };
}
