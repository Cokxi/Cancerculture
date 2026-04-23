import { supabaseServer } from "@/lib/db/server";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import {
  isSubmissionListedPublicly,
  normalizeSubmissionPublicVisibilityStatus,
  showsSubmissionImagePublicly,
} from "@/lib/moderation/submissionPublicVisibility";
import ShameGrid from "./ShameGrid";
import AnimatedCellShame from "./AnimatedCellShame";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getSubmissionSocialLinksBySubmissionIds } from "@/lib/socials/getSubmissionSocialLinks";

export const dynamic = "force-dynamic";

export default async function WallOfShamePage() {
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
    .eq("wall", "shame")
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
    winners
      ?.map((winner) => {
        const submission = submissions.find(
          (entry) => entry.id === winner.submission_id
        );
        const publicVisibilityStatus =
          normalizeSubmissionPublicVisibilityStatus(
            submission?.public_visibility_status
          );

        if (
          !isSubmissionListedPublicly(
            publicVisibilityStatus
          )
        ) {
          return null;
        }

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
          image_url: showsSubmissionImagePublicly(
            publicVisibilityStatus
          )
            ? getPublicImageUrl(winner.r2_key) ?? ""
            : null,
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
      .filter((winner): winner is NonNullable<typeof winner> => winner !== null) ?? []
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
      <div className="p-4 text-white/90 sm:p-6">
        <h1 className="mb-8 flex items-center justify-center gap-2 text-2xl font-[Permanent_Marker] text-[var(--orange-dark)] sm:text-3xl">
          <AnimatedCellShame />
          <span>Wall of Shame</span>
        </h1>

        <ShameGrid
          winners={winnersWithUrls}
          sponsoredMetaByCycleId={sponsoredMetaByCycleId}
        />
      </div>
    </PageWrapper>
  );
}
