import { supabaseAdmin } from "@/lib/db/admin";
import type { CanonicalTeamRole } from "@/lib/auth/teamRoles";
import type { SocialPlatform } from "@/lib/socials/types";

export async function logSocialVerificationAction({
  action,
  actorDiscordUserId,
  actorRole,
  targetDiscordUserId,
  userSocialLinkId,
  platform,
  profileUrl,
  handle,
  note,
}: {
  action: "verify_social" | "unverify_social";
  actorDiscordUserId: string;
  actorRole: CanonicalTeamRole;
  targetDiscordUserId: string;
  userSocialLinkId: number;
  platform: SocialPlatform;
  profileUrl: string;
  handle: string | null;
  note?: string | null;
}) {
  try {
    await supabaseAdmin.from("social_verification_logs").insert({
      action,
      actor_discord_user_id: actorDiscordUserId,
      actor_role: actorRole,
      target_discord_user_id: targetDiscordUserId,
      user_social_link_id: userSocialLinkId,
      platform,
      profile_url: profileUrl,
      handle,
      note: note ?? null,
    });
  } catch (error) {
    console.warn(
      "[logSocialVerificationAction]",
      error
    );
  }
}
