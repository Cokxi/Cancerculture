import { supabaseServer } from "@/lib/db/server";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import FameGrid from "./FameGrid";
import AnimatedCell from "./AnimatedCell";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionSocialLinksBySubmissionIds } from "@/lib/socials/getSubmissionSocialLinks";
import {
  normalizeSubmissionPublicVisibilityStatus,
  SUBMISSION_PUBLIC_VISIBILITY,
} from "@/lib/moderation/submissionPublicVisibility";

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
            "id, discord_username_at_upload, discord_user_id, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text"
          )
          .in("id", submissionIds)
      : { data: [], error: null };

  if (submissionsResult.error) {
    console.error("[wall of fame][submission visibility]", {
      code: submissionsResult.error.code,
    });
  }

  const submissions = (submissionsResult.data ?? []).filter(
    (submission) =>
      normalizeSubmissionPublicVisibilityStatus(
        submission.public_visibility_status
      ) === SUBMISSION_PUBLIC_VISIBILITY.visible
  );
  const visibleSubmissionIds = new Set(
    submissions.map((submission) => submission.id)
  );
  const visibleWinners =
    winners?.filter((winner) =>
      visibleSubmissionIds.has(winner.submission_id)
    ) ?? [];

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
          [...visibleSubmissionIds]
        );

      return (
        visibleWinners.map((winner) => {
          const submission = submissions.find(
            (entry) => entry.id === winner.submission_id
          );
          const publicVisibilityStatus =
            normalizeSubmissionPublicVisibilityStatus(
              submission?.public_visibility_status
            );

          return {
            ...winner,
            discord_username:
              submissionMetaById.get(winner.submission_id)
                ?.discord_username ?? "unknown",
            public_profile_id:
              profileIdByDiscordUserId.get(
                submissionMetaById.get(winner.submission_id)
                  ?.discord_user_id ?? ""
              ) ?? null,
            image_url: getPublicImageUrl(winner.r2_key) ?? "",
            public_visibility_status:
              publicVisibilityStatus,
            public_visibility_reason_code:
              submission?.public_visibility_reason_code ??
              null,
            public_visibility_reason_text:
              submission?.public_visibility_reason_text ??
              null,
            social_links:
              socialLinksBySubmissionId.get(winner.submission_id) ?? [],
          };
        })
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
