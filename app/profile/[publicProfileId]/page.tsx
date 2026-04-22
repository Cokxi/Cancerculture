import BackButton from "@/app/components/ui/BackButton";
import { requireSession } from "@/lib/auth/requireSession";
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
  await requireSession();

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
              <p className="mt-2 text-sm text-gray-400">
                Public profile for logged-in users
              </p>
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
                  <div className="flex flex-col gap-4 md:flex-row">
                    {submission.image_url ? (
                      <img
                        src={submission.image_url}
                        className="h-40 w-40 rounded object-cover"
                        alt={`Submission for cycle ${submission.cycle_id}`}
                      />
                    ) : (
                      <div className="flex h-40 w-40 items-center justify-center rounded bg-orange-200/20 text-4xl">
                        ?
                      </div>
                    )}

                    <div className="space-y-2 text-sm text-gray-300">
                      <div>Cycle: {submission.cycle_id}</div>
                      <div>Votes: {submission.vote_count}</div>
                      <div>Rank: {renderRank(submission)}</div>

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
