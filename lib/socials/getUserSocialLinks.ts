import { supabaseServer } from "@/lib/db/server";
import type { UserSocialLink } from "./types";

export async function getUserSocialLinks(
  discordUserId: string
): Promise<UserSocialLink[]> {
  const { data, error } = await supabaseServer
    .from("user_social_links")
    .select(
      "id, discord_user_id, platform, handle, profile_url, is_verified, verified_at, verified_by_discord_user_id, verification_note, created_at, updated_at"
    )
    .eq("discord_user_id", discordUserId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[getUserSocialLinks]", error);
    return [];
  }

  return (data ?? []) as UserSocialLink[];
}
