import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/db/server";
import { getUserSubmissions } from "@/lib/queries/getUserSubmissions";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export type PublicUserProfileData = {
  avatarUrl: string | null;
  currentDiscordUsername: string;
  discordUserId: string;
  knownDiscordUsernames: string[];
  publicProfileId: string;
  submissions: Awaited<
    ReturnType<typeof getUserSubmissions>
  >;
  submissionCount: number;
  winCount: number;
};

export async function getPublicUserProfileData(
  publicProfileId: string
): Promise<PublicUserProfileData> {
  const { data: userLog, error } = await supabaseServer
    .from("user_logs")
    .select(
      "public_profile_id, discord_user_id, current_discord_username, known_discord_usernames, avatar_key, avatar_updated_at, discord_avatar"
    )
    .eq("public_profile_id", publicProfileId)
    .maybeSingle();

  if (error || !userLog) {
    notFound();
  }

  const submissions = await getUserSubmissions(
    userLog.discord_user_id
  );

  const submissionIds = submissions.map(
    (submission) => submission.id
  );

  const cycleResults =
    submissionIds.length > 0
      ? await supabaseServer
          .from("cycle_results")
          .select("submission_id")
          .in("submission_id", submissionIds)
          .eq("is_winner", true)
      : { data: [], error: null };

  if (cycleResults.error) {
    console.error(
      "[getPublicUserProfileData][cycle_results]",
      cycleResults.error
    );
  }

  const avatarUrl = userLog.avatar_key
    ? getPublicImageUrl(userLog.avatar_key) ?? null
    : userLog.discord_avatar
      ? `https://cdn.discordapp.com/avatars/${userLog.discord_user_id}/${userLog.discord_avatar}.png`
      : null;

  const cacheBustedAvatarUrl =
    avatarUrl && userLog.avatar_updated_at
      ? `${avatarUrl}${
          avatarUrl.includes("?") ? "&" : "?"
        }v=${encodeURIComponent(userLog.avatar_updated_at)}`
      : avatarUrl;

  return {
    avatarUrl: cacheBustedAvatarUrl,
    currentDiscordUsername:
      userLog.current_discord_username ?? "unknown",
    discordUserId: userLog.discord_user_id,
    knownDiscordUsernames:
      userLog.known_discord_usernames ?? [],
    publicProfileId: userLog.public_profile_id,
    submissions,
    submissionCount: submissions.length,
    winCount: cycleResults.data?.length ?? 0,
  };
}
