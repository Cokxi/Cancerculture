"use server";

import { getActorAuditInfo } from "@/lib/auth/getActorAuditInfo";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";

export async function flagUser(params: {
  targetDiscordUserId: string;
  reasonCode: "trolling_low_effort" | "suspicious_behavior" | "other";
  note?: string;
}) {
  const { targetDiscordUserId, reasonCode, note } = params;

  if (!reasonCode) {
    throw new Error("Flag reason is required");
  }

  const moderator = await requireDynamicTeamCapability("users.flag");
  const moderatorAudit = await getActorAuditInfo(
    moderator.discord_user_id
  );

  await supabaseAdmin.from("user_logs").upsert(
    {
      discord_user_id: targetDiscordUserId,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    {
      onConflict: "discord_user_id",
      ignoreDuplicates: true,
    }
  );

  const { data: targetUser, error: fetchError } = await supabaseAdmin
    .from("user_logs")
    .select("flagged_for_review")
    .eq("discord_user_id", targetDiscordUserId)
    .single();

  if (fetchError || !targetUser) {
    throw new Error("Target user not found");
  }

  if (targetUser.flagged_for_review) {
    throw new Error("User already flagged");
  }

  const { error: updateError } = await supabaseAdmin
    .from("user_logs")
    .update({
      flagged_for_review: true,
      flag_reason_code: reasonCode,
      flag_note: note ?? null,
      flagged_at: new Date().toISOString(),
      flagged_by_discord_user_id: moderatorAudit.discordUserId,
      flagged_by_discord_username: moderatorAudit.username,
    })
    .eq("discord_user_id", targetDiscordUserId);

  if (updateError) {
    console.error("Supabase error:", updateError);
    throw new Error(updateError.message);
  }

  return { success: true };
}
