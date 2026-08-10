import { supabaseServer } from "@/lib/db/server";
import {
  createNeutralPublicAvatarResponse,
  proxyPublicDiscordAvatar,
  proxyPublicUploadedAvatar,
} from "@/lib/profile/publicDiscordAvatar";

const PUBLIC_PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ publicProfileId: string }>;
  }
) {
  const { publicProfileId } = await params;

  if (!PUBLIC_PROFILE_ID_PATTERN.test(publicProfileId)) {
    return createNeutralPublicAvatarResponse();
  }

  const { data: userLog, error } = await supabaseServer
    .from("user_logs")
    .select("discord_user_id, discord_avatar, avatar_key")
    .eq("public_profile_id", publicProfileId)
    .maybeSingle();

  if (
    error ||
    !userLog
  ) {
    return createNeutralPublicAvatarResponse();
  }

  const discordUserId = userLog.discord_user_id;

  if (userLog.avatar_key) {
    return proxyPublicUploadedAvatar({
      discordUserId,
      avatarKey: userLog.avatar_key,
    });
  }

  if (!userLog.discord_avatar) {
    return createNeutralPublicAvatarResponse();
  }

  return proxyPublicDiscordAvatar({
    discordUserId,
    discordAvatar: userLog.discord_avatar,
  });
}
