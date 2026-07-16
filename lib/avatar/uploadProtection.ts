import { supabaseAdmin } from "@/lib/db/admin";

export const AVATAR_UPLOAD_COOLDOWN_MINUTES = 10;

export type AvatarUploadEligibility = {
  canUpload: boolean;
  cooldownMinutes: number;
  lastUploadedAt: string | null;
  nextAllowedAt: string | null;
  retryAfterSeconds: number;
};

export async function getAvatarUploadEligibility(
  discordUserId: string
): Promise<AvatarUploadEligibility> {
  const { data: userLog, error } = await supabaseAdmin
    .from("user_logs")
    .select("avatar_updated_at")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (error) {
    console.error("[avatar upload eligibility]", { code: error.code });
    throw new Error("AVATAR_UPLOAD_DEPENDENCY_UNAVAILABLE");
  }

  const lastUploadedAt = userLog?.avatar_updated_at ?? null;

  if (!lastUploadedAt) {
    return {
      canUpload: true,
      cooldownMinutes: AVATAR_UPLOAD_COOLDOWN_MINUTES,
      lastUploadedAt: null,
      nextAllowedAt: null,
      retryAfterSeconds: 0,
    };
  }

  const cooldownMs =
    AVATAR_UPLOAD_COOLDOWN_MINUTES * 60 * 1000;
  const nextAllowedAtMs =
    new Date(lastUploadedAt).getTime() + cooldownMs;
  const retryAfterMs = Math.max(0, nextAllowedAtMs - Date.now());

  return {
    canUpload: retryAfterMs === 0,
    cooldownMinutes: AVATAR_UPLOAD_COOLDOWN_MINUTES,
    lastUploadedAt,
    nextAllowedAt: new Date(nextAllowedAtMs).toISOString(),
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  };
}
