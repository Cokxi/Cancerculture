import { supabaseAdmin } from "@/lib/db/admin";

export async function logAvatarUpload({
  discordUserId,
  status,
  reason,
  avatarKey = null,
  cooldownUntil = null,
}: {
  discordUserId: string | null;
  status: "success" | "failed";
  reason?: string | null;
  avatarKey?: string | null;
  cooldownUntil?: string | null;
}) {
  try {
    await supabaseAdmin.from("avatar_upload_logs").insert({
      discord_user_id: discordUserId,
      status,
      reason: reason ?? null,
      avatar_key: avatarKey,
      cooldown_until: cooldownUntil,
    });
  } catch (error) {
    console.error("[AVATAR UPLOAD LOG]", error);
  }
}
