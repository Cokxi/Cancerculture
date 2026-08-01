"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

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
  const { error } = await supabaseAdmin.rpc("ban_website_user", {
    p_actor_discord_user_id: admin.discord_user_id,
    p_target_discord_user_id: targetDiscordUserId,
    p_reason: reason.trim(),
    p_source: source ?? "admin_manual",
  });

  if (error) throw error;

  return { success: true };
}
