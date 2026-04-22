"use server";

import { getActorAuditInfo } from "@/lib/auth/getActorAuditInfo";
import { requireAdmin } from "@/lib/auth/guards";
import { supabaseAdmin } from "@/lib/db/admin";

export async function unflagUser(params: {
  targetDiscordUserId: string;
  reason: string;
}) {
  const { targetDiscordUserId, reason } = params;

  if (!reason?.trim()) {
    throw new Error("Unflag reason is required");
  }

  const admin = await requireAdmin();
  const adminAudit = await getActorAuditInfo(admin.discord_user_id);

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
      unflagged_at: new Date().toISOString(),
      unflagged_by_discord_user_id: adminAudit.discordUserId,
      unflagged_by_discord_username: adminAudit.username,
      updated_at: new Date().toISOString(),
    })
    .eq("discord_user_id", targetDiscordUserId);

  if (updateError) {
    console.error("Supabase error:", updateError);
    throw new Error(updateError.message);
  }

  return { success: true };
}
