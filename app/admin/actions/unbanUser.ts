"use server";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function unbanUser(params: {
  targetDiscordUserId: string;
  reason: string;
}) {
  const { targetDiscordUserId, reason } = params;

  if (!reason?.trim()) {
    throw new Error("Unban reason is required");
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

  if (!targetUser?.is_banned) {
    throw new Error("User is not banned");
  }

  const { error } = await supabaseAdmin
    .from("user_logs")
    .update({
      is_banned: false,
      ban_reason: null,
      ban_source: null,
      banned_at: null,
      banned_by_discord_user_id: null,
      banned_by_discord_username: null,

      unban_reason: reason,
      unbanned_at: new Date().toISOString(),
      unbanned_by_discord_user_id: adminDiscordId,
      unbanned_by_discord_username: adminUsername,
    })
    .eq("discord_user_id", targetDiscordUserId);

  if (error) throw error;

  return { success: true };
}
