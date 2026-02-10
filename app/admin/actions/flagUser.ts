"use server";

import { supabaseAdmin } from "@/lib/db/admin";
import { requireModOrAdmin } from "@/lib/auth/guards";

export async function flagUser(params: {
  targetDiscordUserId: string;
  reasonCode: "trolling_low_effort" | "suspicious_behavior" | "other";
  note?: string;
}) {
  const { targetDiscordUserId, reasonCode, note } = params;

  if (!reasonCode) {
    throw new Error("Flag reason is required");
  }

  // 🔐 Auth
  const moderator = await requireModOrAdmin();
  const moderatorDiscordId = moderator.discord_user_id;

  // 🧾 Username-Snapshot des Mods (optional)
  const { data: moderatorLog } = await supabaseAdmin
    .from("user_logs")
    .select("current_discord_username")
    .eq("discord_user_id", moderatorDiscordId)
    .single();

  const moderatorUsername =
    moderatorLog?.current_discord_username ?? null;

  // 🧠 Sicherstellen, dass user_logs-Zeile existiert
  await supabaseAdmin.from("user_logs").upsert(
    {
      discord_user_id: targetDiscordUserId,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "discord_user_id" }
  );

  // 🔄 Re-fetch des Ziel-Users
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

  // 🚩 Flag setzen
  const { error: updateError } = await supabaseAdmin
    .from("user_logs")
    .update({
      flagged_for_review: true,
      flag_reason_code: reasonCode,
      flag_note: note ?? null,
      flagged_at: new Date().toISOString(),
      flagged_by_discord_user_id: moderatorDiscordId,
      flagged_by_discord_username: moderatorUsername,
    })
    .eq("discord_user_id", targetDiscordUserId);

  if (updateError) {
    console.error("Supabase error:", updateError);
    throw new Error(updateError.message);
  }

  return { success: true };
}
