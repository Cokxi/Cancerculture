import { supabaseServer } from "@/lib/db/server";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import FameGrid from "./FameGrid";
import AnimatedCell from "./AnimatedCell";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionSocialLinksBySubmissionIds } from "@/lib/socials/getSubmissionSocialLinks";

export const dynamic = "force-dynamic";

export default async function WallOfFamePage() {
  const { data: winners } = await supabaseServer
    .from("winner_public_profiles")
    .select(`
      id,
      submission_id,
      r2_key,
      cycle_id,
      wallet_address,
      payout_choice,
      split_percent,
      charity,
      vote_count,
      created_at
    `)
    .eq("wall", "fame")
    .order("created_at", { ascending: false });

  const submissionIds =
    winners?.map((winner) => winner.submission_id) ?? [];

  const submissionsResult =
    submissionIds.length > 0
      ? await supabaseServer
          .from("submissions")
          .select(
            "id, discord_username_at_upload, discord_user_id"
          )
          .in("id", submissionIds)
      : { data: [] };
  const submissions = submissionsResult.data ?? [];

  const discordUserIds = Array.from(
    new Set(
      submissions.map(
        (submission) => submission.discord_user_id
      )
    )
  );

  const userLogsResult =
    discordUserIds.length > 0
      ? await supabaseServer
          .from("user_logs")
          .select("discord_user_id, public_profile_id")
          .in("discord_user_id", discordUserIds)
      : { data: [] };
  const userLogs = userLogsResult.data ?? [];

  const submissionMetaById = new Map(
    submissions.map((submission) => [
      submission.id,
      {
        discord_username:
          submission.discord_username_at_upload ?? "unknown",
        discord_user_id: submission.discord_user_id,
      },
    ])
  );

  const profileIdByDiscordUserId = new Map(
    userLogs.map((userLog) => [
      userLog.discord_user_id,
      userLog.public_profile_id,
    ])
  );

  const winnersWithUrls =
    await (async () => {
      const socialLinksBySubmissionId =
        await getSubmissionSocialLinksBySubmissionIds(
          submissionIds
        );

      return (
    winners?.map((w) => ({
      ...w,
      discord_username:
        submissionMetaById.get(w.submission_id)
          ?.discord_username ?? "unknown",
      public_profile_id:
        profileIdByDiscordUserId.get(
        submissionMetaById.get(w.submission_id)
          ?.discord_user_id ?? ""
        ) ?? null,
      image_url: getPublicImageUrl(w.r2_key) ?? "",
      social_links:
        socialLinksBySubmissionId.get(w.submission_id) ?? [],
    })) ?? []
      );
    })();
  const sponsoredMetaEntries = await Promise.all(
    Array.from(
      new Set(
        winnersWithUrls.map((winner) => winner.cycle_id)
      )
    ).map(async (cycleId) => [
      cycleId,
      await getCycleSponsoredMeta(cycleId),
    ])
  );
  const sponsoredMetaByCycleId = Object.fromEntries(
    sponsoredMetaEntries
  );

  return (
    <PageWrapper>
      <div className="p-4 sm:p-6 text-white/90">
        <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">
          <AnimatedCell />
          <span>Wall of Fame</span>
        </h1>

        <FameGrid
          winners={winnersWithUrls}
          sponsoredMetaByCycleId={sponsoredMetaByCycleId}
        />
      </div>
    </PageWrapper>
  );
}
