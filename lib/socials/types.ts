export const SOCIAL_PLATFORMS = [
  "x",
  "instagram",
  "tiktok",
  "facebook",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type UserSocialLink = {
  id: number;
  discord_user_id: string;
  platform: SocialPlatform;
  handle: string | null;
  profile_url: string;
  is_verified: boolean;
  verified_at: string | null;
  verified_by_discord_user_id: string | null;
  verification_note: string | null;
  created_at: string;
  updated_at: string;
};

export type PublicSocialLink = Pick<
  UserSocialLink,
  "id" | "platform" | "handle" | "profile_url" | "is_verified"
>;
