"use server";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireAdmin } from "@/lib/auth/guards";

export async function unflagUser(params: {
  targetDiscordUserId: string;
  reason: string;
}) {
  const { targetDiscordUserId, reason } = params;

  if (!reason || !reason.trim()) {
    throw new Error("Unflag reason is required");
  }

  
  const admin = await requireAdmin();
  const adminDiscordId = admin.discord_user_id;


  const { data: adminLog } = await supabaseAdmin
    .from("user_logs")
    .select("current_discord_username")
    .eq("discord_user_id", adminDiscordId)
    .single();

  const adminUsername =
    adminLog?.current_discord_username ?? null;

  
  const { data: targetUser, error: fetchError } = await supabaseAdmin
    .from("user_logs")
    .select("flagged_for_review")
    .eq("discord_user_id", targetDiscordUserId)
    .single();

  if (fetchError || !targetUser) {
    throw new Error("Target user not found");
  }

  if (!targetUser.flagged_for_review) {
    throw new Error("User is not flagged");
  }

  
  const { error: updateError } = await supabaseAdmin
    .from("user_logs")
    .update({
  flagged_for_review: false,
  flagged_at: null,
  flag_reason_code: null,
  flag_note: null,

  unflag_reason: reason,
  unflagged_by_discord_username: adminUsername,
  updated_at: new Date().toISOString(),
})

    .eq("discord_user_id", targetDiscordUserId);

  if (updateError) {
    console.error("Supabase error:", updateError);
    throw new Error(updateError.message);
  }

  return { success: true };
}
