import { supabaseServer } from "@/lib/db/server";
import { getUserSocialLinks } from "./getUserSocialLinks";
import type { SocialPlatform } from "./types";

export type UserSocialSettings = {
  showSocialsOnSubmissions: boolean;
  socialCount: number;
  verifiedSocialCount: number;
  socialPlatforms: SocialPlatform[];
};

export async function getUserSocialSettings(
  discordUserId: string
): Promise<UserSocialSettings> {
  const [userLogResult, socialLinks] = await Promise.all([
    supabaseServer
      .from("user_logs")
      .select("show_socials_on_submissions")
      .eq("discord_user_id", discordUserId)
      .maybeSingle(),
    getUserSocialLinks(discordUserId),
  ]);

  if (userLogResult.error) {
    console.error(
      "[getUserSocialSettings][user_logs]",
      userLogResult.error
    );
  }

  const verifiedSocials = socialLinks.filter(
    (social) => social.is_verified
  );

  return {
    showSocialsOnSubmissions:
      userLogResult.data?.show_socials_on_submissions ?? false,
    socialCount: socialLinks.length,
    verifiedSocialCount: verifiedSocials.length,
    socialPlatforms: verifiedSocials.map(
      (social) => social.platform
    ),
  };
}
