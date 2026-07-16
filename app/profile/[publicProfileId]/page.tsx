import BackButton from "@/app/components/ui/BackButton";
import Link from "next/link";
import PublicProfileSocialsSection from "@/app/components/profile/PublicProfileSocialsSection";
import { getTeamMember } from "@/lib/auth/guards";
import { SUBMISSION_PUBLIC_VISIBILITY } from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import { getPublicUserProfileData } from "@/lib/profile/getPublicUserProfileData";

function renderRank(submission: {
  rank: number | null;
  total: number;
  tie_count: number;
}) {
  if (!submission.rank) {
    return "-";
  }

  return `${submission.rank} / ${submission.total}${
    submission.tie_count > 1
      ? ` (${submission.tie_count} tied)`
      : ""
  }`;
}

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ publicProfileId: string }>;
}) {
  let canModerateSocials = false;

  try {
    await getTeamMember();
    canModerateSocials = true;
  } catch {
    canModerateSocials = false;
  }

  const { publicProfileId } = await params;
  const profile = await getPublicUserProfileData(publicProfileId);

  return (
    <>
      <BackButton href="/" label="Back" />

      <div className="mx-auto max-w-4xl space-y-8 px-4 py-10 text-white">
        <div className="rounded-2xl border border-white/10 bg-black/40 p-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-orange-500/20 text-2xl">
              {profile.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  className="h-full w-full object-cover"
                  alt={`${profile.currentDiscordUsername} avatar`}
                />
              ) : (
                "?"
              )}
            </div>

            <div>
              <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
                {profile.currentDiscordUsername}
              </h1>
            </div>

            <div className="flex flex-wrap justify-center gap-3 text-sm">
              <div className="rounded-full bg-white/5 px-4 py-2">
                Submissions: {profile.submissionCount}
              </div>
              <div className="rounded-full bg-white/5 px-4 py-2">
                Wins: {profile.winCount}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-black/40 p-6">
          <h2 className="mb-4 text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            Username History
          </h2>

          {profile.knownDiscordUsernames.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {profile.knownDiscordUsernames.map((username) => (
                <span
                  key={username}
                  className="rounded-full bg-white/5 px-3 py-1 text-sm text-white/90"
                >
                  {username}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              No username history available.
            </p>
          )}
        </div>

        <PublicProfileSocialsSection
          socials={profile.socialLinks}
          showSocials={profile.showSocials}
          canModerate={canModerateSocials}
        />

        <div className="rounded-2xl border border-white/10 bg-black/40 p-6">
          <h2 className="mb-4 text-xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            Submissions
          </h2>

          {profile.submissions.length > 0 ? (
            <div className="space-y-6">
              {profile.submissions.map((submission) => (
                <div
                  key={submission.id}
                  className="rounded-xl border border-[var(--orange-dark)]/30 bg-black/40 p-4"
                >
                  {(() => {
                    const destinationHref = submission.destination_href;

                    return (
                  <div className="flex flex-col gap-4 md:flex-row">
                    {submission.image_url ? (
                      destinationHref ? (
                        <Link
                          href={destinationHref}
                          className="block h-40 w-40 rounded focus:outline-none focus:ring-2 focus:ring-[var(--orange-dark)]"
                        >
                          <img
                            src={submission.image_url}
                            className="h-40 w-40 rounded object-cover transition hover:opacity-85"
                            alt={`Submission for cycle ${submission.cycle_id}`}
                          />
                        </Link>
                      ) : (
                        <img
                          src={submission.image_url}
                          className="h-40 w-40 rounded object-cover"
                          alt={`Submission for cycle ${submission.cycle_id}`}
                        />
                      )
                    ) : (
                      <div className="flex h-40 w-40 items-center justify-center rounded bg-orange-200/20 px-3 text-center text-sm text-white/80">
                        Hidden pending legal review
                      </div>
                    )}

                    <div className="space-y-2 text-sm text-gray-300">
                      <div>Cycle: {submission.cycle_id}</div>
                      <div>Votes: {submission.vote_count}</div>
                      <div>Rank: {renderRank(submission)}</div>

                      {destinationHref ? (
                        <Link
                          href={destinationHref}
                          className="inline-flex rounded-full border border-[var(--orange-dark)]/40 px-3 py-1 text-xs text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
                        >
                          {destinationHref.startsWith("/submissions")
                            ? "View in Current Submissions"
                            : "View in Cycle History"}
                        </Link>
                      ) : null}

                      {submission.public_visibility_status ===
                        SUBMISSION_PUBLIC_VISIBILITY.legalReview && (
                        <div className="rounded-lg bg-yellow-500/10 p-3 text-yellow-200">
                          <div className="font-semibold">
                            Temporarily hidden pending legal review
                          </div>
                          {submission.public_visibility_reason_code && (
                            <div className="mt-1 text-xs">
                              {formatReason(
                                submission.public_visibility_reason_code
                              )}
                            </div>
                          )}
                          {submission.public_visibility_reason_text && (
                            <div className="mt-1 text-xs">
                              {submission.public_visibility_reason_text}
                            </div>
                          )}
                        </div>
                      )}

                      {submission.is_disqualified ? (
                        <div className="pt-2 text-red-400">
                          Disqualified

                          {submission.disqualification_reason_code && (
                            <div className="mt-1 text-xs text-red-300">
                              {formatReason(
                                submission.disqualification_reason_code
                              )}
                            </div>
                          )}

                          {submission.disqualification_reason_text && (
                            <div className="text-xs text-red-300">
                              {submission.disqualification_reason_text}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="pt-2 text-green-400">
                          Active
                        </div>
                      )}
                    </div>
                  </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              No submissions yet.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
