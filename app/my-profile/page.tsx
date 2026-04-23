import BackButton from "@/app/components/ui/BackButton";
import AvatarUpload from "@/app/components/ui/AvatarUpload";
import { requireSession } from "@/lib/auth/requireSession";
import { formatReason } from "@/lib/profile/formatReason";
import { getUserProfileData } from "@/lib/profile/getUserProfileData";
import ProfileSocialsSection from "@/app/components/profile/ProfileSocialsSection";
import ProfileSections from "./ProfileSections";

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

export default async function MyProfilePage() {
  const session = await requireSession();
  const {
    activeCycleId,
    avatarUrl,
    currentDiscordUsername,
    currentSubmission,
    currentSubmissionPrivateData,
    discordUserId,
    joinedDate,
    showSocialsOnProfile,
    showSocialsOnSubmissions,
    socialLinks,
    submissions,
    votes,
  } = await getUserProfileData(session.discord_user_id);

  return (
    <>
      <BackButton href="/" label="Back" />

      <div className="mx-auto max-w-2xl space-y-10 px-4 py-10 text-white">
        <div className="flex flex-col items-center space-y-4 text-center">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-orange-500/20 text-2xl">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                className="h-full w-full object-cover"
                alt="User Avatar"
              />
            ) : (
              "?"
            )}
          </div>

          <AvatarUpload />

          <h1 className="mb-8 flex items-center justify-center gap-2 text-2xl font-[Permanent_Marker] text-[var(--orange-dark)] sm:text-3xl">
            My Profile
          </h1>

          <p className="text-sm text-gray-300">
            Joined: {joinedDate ?? "-"}
          </p>

          <div className="w-full max-w-md rounded-2xl border border-[var(--orange-dark)]/40 bg-black/30 px-4 py-3 text-left text-sm text-gray-200">
            <div>
              <span className="text-[var(--orange-dark)]">
                Discord Name:
              </span>{" "}
              {currentDiscordUsername ?? "-"}
            </div>
            <div className="mt-1">
              <span className="text-[var(--orange-dark)]">
                Discord ID:
              </span>{" "}
              <code className="text-gray-100">{discordUserId}</code>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <ProfileSocialsSection
            initialSocialLinks={socialLinks}
            initialShowSocialsOnProfile={showSocialsOnProfile}
            initialShowSocialsOnSubmissions={showSocialsOnSubmissions}
          />
        </div>

        <div className="space-y-4">
          <h2 className="mb-6 flex items-center justify-center gap-2 text-xl font-[Permanent_Marker] text-[var(--orange-dark)] sm:text-2xl">
            Current Cycle
          </h2>

          <div className="flex flex-col items-center rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/40 p-4">
            {currentSubmission?.image_url ? (
              <img
                src={currentSubmission.image_url}
                className="mb-3 h-48 w-48 rounded object-cover"
                alt={`Submission for cycle ${currentSubmission.cycle_id}`}
              />
            ) : (
              <div className="mb-3 flex h-48 w-48 items-center justify-center rounded bg-orange-200/20 text-4xl">
                {activeCycleId ? "?" : "-"}
              </div>
            )}

            {currentSubmission ? (
              <>
                <p className="text-sm text-gray-300">
                  Cycle: {currentSubmission.cycle_id}
                </p>

                <p className="text-sm text-gray-300">
                  Votes: {currentSubmission.vote_count}
                </p>

                <p className="text-sm text-gray-300">
                  Rank: {renderRank(currentSubmission)}
                </p>

                <div className="mt-2 text-xs">
                  {currentSubmission.is_disqualified ? (
                    <div className="text-red-400">
                      Disqualified

                      {currentSubmission.disqualification_reason_code && (
                        <div className="mt-1 text-[11px] text-red-300">
                          {formatReason(
                            currentSubmission.disqualification_reason_code
                          )}
                        </div>
                      )}

                      {currentSubmission.disqualification_reason_text && (
                        <div className="text-[11px] text-red-300">
                          {currentSubmission.disqualification_reason_text}
                        </div>
                      )}

                      {currentSubmission.disqualified_by_discord_username && (
                        <div className="text-[11px] text-red-300">
                          by{" "}
                          {
                            currentSubmission.disqualified_by_discord_username
                          }
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-green-400">Active</div>
                  )}
                </div>

                {currentSubmissionPrivateData && (
                  <div className="mt-4 w-full max-w-md rounded-lg bg-white/5 p-3 text-left text-sm text-white">
                    <div className="font-semibold text-[var(--orange-dark)]">
                      Your saved submission details
                    </div>

                    <div className="mt-2">
                      <strong>Wallet:</strong>{" "}
                      {currentSubmissionPrivateData.wallet_address
                        ? currentSubmissionPrivateData.wallet_address
                        : currentSubmissionPrivateData.payout_choice ===
                            "donate"
                        ? "No wallet required for full donation"
                        : "Not provided"}
                    </div>

                    <div className="mt-1">
                      <strong>Payout:</strong>{" "}
                      {currentSubmissionPrivateData.payout_choice}
                    </div>

                    {currentSubmissionPrivateData.payout_choice ===
                      "split" &&
                      currentSubmissionPrivateData.split_percent !== null && (
                        <>
                          <div className="mt-1">
                            <strong>You receive:</strong>{" "}
                            {currentSubmissionPrivateData.split_percent}%
                          </div>
                          <div className="mt-1">
                            <strong>Charity receives:</strong>{" "}
                            {100 -
                              currentSubmissionPrivateData.split_percent}
                            %
                          </div>
                        </>
                      )}

                    {currentSubmissionPrivateData.charity && (
                      <div className="mt-1">
                        <strong>Charity:</strong>{" "}
                        {currentSubmissionPrivateData.charity}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : activeCycleId ? (
              <div className="space-y-1 text-center">
                <p className="text-sm text-gray-200">
                  No submission in the active cycle yet.
                </p>
                <p className="text-xs text-gray-400">
                  Your current slot for cycle #{activeCycleId} is still empty.
                </p>
              </div>
            ) : (
              <div className="space-y-1 text-center">
                <p className="text-sm text-gray-200">
                  No active cycle right now.
                </p>
                <p className="text-xs text-gray-400">
                  Your current submission will show up here once a new cycle starts.
                </p>
              </div>
            )}
          </div>
        </div>

        <ProfileSections submissions={submissions} votes={votes} />
      </div>
    </>
  );
}
