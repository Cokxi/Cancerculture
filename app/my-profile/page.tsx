import BackButton from "@/app/components/ui/BackButton";
import AvatarUpload from "@/app/components/ui/AvatarUpload";
import SolProfileWalletSettings from "@/app/components/auth/SolProfileWalletSettings";
import Image from "next/image";
import { getSessionState } from "@/lib/auth/sessionState";
import { SUBMISSION_PUBLIC_VISIBILITY } from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import { getUserProfileData } from "@/lib/profile/getUserProfileData";
import type {
  CurrentProfileSubmission,
  ProfileSubmission,
} from "@/lib/profile/getUserProfileData";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import { getSolProfileWallet } from "@/lib/solana/profileWallet.server";
import ProfileSocialsSection from "@/app/components/profile/ProfileSocialsSection";
import { redirect } from "next/navigation";
import ProfileSections from "./ProfileSections";
import SavedMemesClient from "./saved-memes/SavedMemesClient";
import { getOwnSavedMemes } from "@/lib/savedMemes/service.server";
import { loadOwnSubmissionReports } from "@/lib/reports/submissionReportOwn.server";
import OwnSubmissionReportsList from "@/app/my-reports/OwnSubmissionReportsList";
import { loadOwnDisqualificationHistory } from "@/lib/profile/disqualificationHistoryReadModel.server";
import DisqualificationHistoryList from "@/app/components/profile/DisqualificationHistoryList";
import {
  getOwnWinnerClaims,
} from "@/lib/winnerClaims/service.server";
import PendingWinnerClaims from "./PendingWinnerClaims";
import PendingPayoutReturnClaims from "./PendingPayoutReturnClaims";
import PendingDonationCorrections from "./PendingDonationCorrections";
import { getOwnPayoutDonationCorrections, getOwnPayoutReturnClaims } from "@/lib/payouts/service.server";
import { getDonationOrganizationCatalog } from "@/lib/organizations/data.server";
import WalletIssueIntakeForm from "./WalletIssueIntakeForm";
import { getOwnWalletIssueIntakes } from "@/lib/walletIssues/service.server";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";
import type { WalletIssueStatus } from "@/lib/walletIssues/contract";
import { enrichOwnWinnerClaims } from "@/lib/profile/profileWinSummary";
import { loadOwnComments, loadOwnMentions } from "@/lib/comments/commentOwner.server";
import { OwnCommentsList, OwnMentionsList } from "./CommentOwnerLists";

const MY_PROFILE_PATH = "/my-profile";
const MY_PROFILE_LOGIN_PATH =
  `/api/auth/discord/login?state=${MY_PROFILE_PATH}`;
const PROFILE_PREVIEW_LIMIT = 5;

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

function renderPublicVisibilityStatus(
  submission: ProfileSubmission
) {
  if (
    submission.public_visibility_status ===
    SUBMISSION_PUBLIC_VISIBILITY.legalReview
  ) {
    return "Hidden pending legal review";
  }

  if (
    submission.public_visibility_status ===
    SUBMISSION_PUBLIC_VISIBILITY.removed
  ) {
    return "Removed from public view";
  }

  return null;
}

function CurrentSubmissionCard({
  submission,
  showWalletAddress,
  walletIssueIntakeAllowed,
  walletIssueStatus,
  turnstileSiteKey,
}: {
  submission: CurrentProfileSubmission;
  showWalletAddress: boolean;
  walletIssueIntakeAllowed: boolean;
  walletIssueStatus: WalletIssueStatus | null;
  turnstileSiteKey: string | null;
}) {
  const privateData = submission.privateData;

  return (
    <article className="flex w-full min-w-0 max-w-lg basis-[28rem] grow flex-col items-center rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/40 p-4">
      {submission.image_url ? (
        <Image
          src={getSubmissionThumbnailUrl(submission.image_url)}
          className="mb-3 h-48 w-48 rounded object-cover"
          alt={`Submission ${submission.id} for cycle ${submission.cycle_number}`}
          width={192}
          height={192}
          unoptimized
        />
      ) : (
        <div className="mb-3 flex h-48 w-48 items-center justify-center rounded bg-orange-200/20 text-4xl">
          {renderPublicVisibilityStatus(submission) ? "-" : "?"}
        </div>
      )}

      <p className="text-sm text-gray-300">
        Cycle #{submission.cycle_number} / Submission #{submission.id}
      </p>
      <p className="text-sm text-gray-300">Votes: {submission.vote_count}</p>
      <p className="text-sm text-gray-300">Rank: {renderRank(submission)}</p>

      <div className="mt-2 text-xs">
        {submission.is_disqualified ? (
          <div className="text-red-400">
            Disqualified
            {(submission.disqualification_reason_code ||
              submission.disqualification_reason_category) && (
              <div className="mt-1 text-[11px] text-red-300">
                {formatReason(
                  submission.disqualification_reason_code ??
                    submission.disqualification_reason_category!
                )}
              </div>
            )}
            {submission.disqualification_reason_text && (
              <div className="mt-1 text-[11px] text-red-300">
                Explanation: {submission.disqualification_reason_text}
              </div>
            )}
          </div>
        ) : renderPublicVisibilityStatus(submission) ? (
          <div className="text-yellow-300">
            {renderPublicVisibilityStatus(submission)}
            {submission.public_visibility_reason_code && (
              <div className="mt-1 text-[11px] text-yellow-200">
                {formatReason(submission.public_visibility_reason_code)}
              </div>
            )}
            {submission.public_visibility_reason_text && (
              <div className="text-[11px] text-yellow-200">
                {submission.public_visibility_reason_text}
              </div>
            )}
          </div>
        ) : (
          <div className="text-green-400">Active</div>
        )}
      </div>

      {privateData && (
        <div className="mt-4 w-full min-w-0 max-w-md rounded-lg bg-white/5 p-3 text-left text-sm text-white">
          <div className="font-semibold text-[var(--orange-dark)]">
            Your saved submission details
          </div>
          {showWalletAddress && (
            <div className="mt-2 min-w-0">
              <strong>Wallet:</strong>
              {privateData.wallet_address ? (
                <code
                  className="mt-1 block max-w-full overflow-x-auto whitespace-nowrap rounded-md bg-black/30 px-2 py-1 font-mono text-sm text-gray-100 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  title={privateData.wallet_address}
                  tabIndex={0}
                >
                  {privateData.wallet_address}
                </code>
              ) : (
                <span>
                  {" "}
                  {privateData.payout_choice === "donate"
                    ? "No wallet required for full donation"
                    : "Not provided"}
                </span>
              )}
            </div>
          )}
          <div className="mt-1">
            <strong>Payout:</strong> {privateData.payout_choice}
          </div>
          {privateData.payout_choice === "split" &&
            privateData.split_percent !== null && (
              <>
                <div className="mt-1">
                  <strong>You receive:</strong> {privateData.split_percent}%
                </div>
                <div className="mt-1">
                  <strong>Charity receives:</strong>{" "}
                  {100 - privateData.split_percent}%
                </div>
              </>
            )}
          {privateData.charity && (
            <div className="mt-1">
              <strong>Charity:</strong> {privateData.charity}
            </div>
          )}
        </div>
      )}
      {walletIssueIntakeAllowed &&
      (privateData?.payout_choice === "keep" || privateData?.payout_choice === "split") ? (
        <div className="w-full max-w-md">
          <WalletIssueIntakeForm
            submissionId={submission.id}
            initialStatus={walletIssueStatus}
            turnstileSiteKey={turnstileSiteKey}
          />
        </div>
      ) : null}
    </article>
  );
}

export default async function MyProfilePage() {
  const sessionState = await getSessionState();

  if (sessionState.status === "anonymous") {
    redirect(MY_PROFILE_LOGIN_PATH);
  }

  if (sessionState.status === "restricted") {
    const code =
      sessionState.reason === "discord_banned"
        ? "DISCORD_BANNED"
        : "WEBSITE_BANNED";

    redirect(`/banned?code=${code}`);
  }

  if (sessionState.status === "dependency_unavailable") {
    return (
      <>
        <BackButton href="/" label="Home" />

        <main className="flex min-h-screen items-center justify-center px-6 text-white">
          <div
            className="max-w-xl rounded-2xl border border-white/10 bg-black/70 p-8 text-center"
            role="status"
          >
            <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
              Profile temporarily unavailable
            </h1>
            <p className="mt-4 text-white/70">
              We could not verify your session right now. Please try
              again shortly.
            </p>
          </div>
        </main>
      </>
    );
  }

  const session = sessionState.session;
  const [profileData, profileWallet, winnings, payoutReturns, donationCorrections, organizations, walletIssueIntakes, savedMemesPreview, reportsPreview, moderationHistoryPreview, commentsPreview, mentionsPreview] = await Promise.all([
    getUserProfileData(session.discord_user_id),
    getSolProfileWallet(session).catch(() => undefined),
    getOwnWinnerClaims(session).catch(() => null),
    getOwnPayoutReturnClaims(session).catch(() => null),
    getOwnPayoutDonationCorrections(session).catch(() => null),
    getDonationOrganizationCatalog().catch(() => []),
    getOwnWalletIssueIntakes(session).catch(() => []),
    getOwnSavedMemes({
      sessionId: session.session_id,
      limit: PROFILE_PREVIEW_LIMIT,
    }).catch(() => null),
    loadOwnSubmissionReports({
      discordUserId: session.discord_user_id,
      limit: PROFILE_PREVIEW_LIMIT,
    }).catch(() => null),
    loadOwnDisqualificationHistory({}).catch(() => null),
    loadOwnComments({
      sessionId: session.session_id,
      limit: PROFILE_PREVIEW_LIMIT,
    }).catch(() => null),
    loadOwnMentions({
      sessionId: session.session_id,
      limit: PROFILE_PREVIEW_LIMIT,
    }).catch(() => null),
  ]);
  const walletIssueBySubmission = new Map(
    walletIssueIntakes.map((intake) => [intake.submissionId, intake.status] as const)
  );
  const turnstileSiteKey = getTurnstileClientSiteKey();
  const {
    activeCycleId,
    activeCycleNumber,
    avatarUrl,
    currentDiscordUsername,
    currentSubmissions,
    discordUserId,
    joinedDate,
    showSocialsOnProfile,
    showSocialsOnSubmissions,
    socialLinks,
    submissions,
    uploadQuota,
    votes,
  } = profileData;
  const hasSavedProfileWallet =
    profileWallet?.factorActive === true &&
    profileWallet.walletAddress !== null;
  const profileWalletAvailable = profileWallet !== undefined;
  const walletIssueIntakeAllowed =
    profileWallet !== undefined && profileWallet.factorActive === false;
  const profileWinnings = enrichOwnWinnerClaims(
    winnings?.items ?? null,
    submissions,
  );

  return (
    <>
      <BackButton href="/" label="Home" />

      <div className="mx-auto max-w-2xl space-y-10 px-4 py-10 text-white">
        <div className="flex flex-col items-center space-y-4 text-center">
          <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-orange-500/20 text-2xl">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                className="h-full w-full object-cover"
                alt="User Avatar"
                width={96}
                height={96}
                unoptimized
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

        <SolProfileWalletSettings />

        <PendingWinnerClaims items={winnings?.items ?? null} databaseTime={winnings?.databaseTime ?? null} />

        <PendingPayoutReturnClaims items={payoutReturns?.items ?? null} databaseTime={payoutReturns?.databaseTime ?? null} />

        <PendingDonationCorrections items={donationCorrections?.items ?? null} organizations={organizations} databaseTime={donationCorrections?.databaseTime ?? null} />

        <div className="space-y-4">
          <ProfileSocialsSection
            initialSocialLinks={socialLinks}
            initialShowSocialsOnProfile={showSocialsOnProfile}
            initialShowSocialsOnSubmissions={showSocialsOnSubmissions}
          />
        </div>

        <div className="relative left-1/2 w-[calc(100vw-2rem)] max-w-[120rem] -translate-x-1/2 space-y-4">
          <h2 className="mb-6 flex items-center justify-center gap-2 text-xl font-[Permanent_Marker] text-[var(--orange-dark)] sm:text-2xl">
            Current Cycle
          </h2>

          {uploadQuota && (
            <div className="mx-auto w-full max-w-5xl rounded-lg border border-[var(--orange-dark)]/40 bg-black/30 p-4 text-center text-sm text-gray-200">
              <strong className="text-[var(--orange-dark)]">
                {uploadQuota.used} of {uploadQuota.limit} submissions used
              </strong>
              <div>{uploadQuota.remaining} remaining</div>
              {uploadQuota.cooldownRemainingSeconds > 0 && (
                <div className="mt-1 text-yellow-300">
                  Next upload in about {uploadQuota.cooldownRemainingSeconds} seconds
                </div>
              )}
            </div>
          )}

          {currentSubmissions.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-4">
              {currentSubmissions.map((submission) => (
                <CurrentSubmissionCard
                  key={submission.id}
                  submission={submission}
                  showWalletAddress={profileWalletAvailable && !hasSavedProfileWallet}
                  walletIssueIntakeAllowed={walletIssueIntakeAllowed}
                  walletIssueStatus={walletIssueBySubmission.get(submission.id) ?? null}
                  turnstileSiteKey={turnstileSiteKey}
                />
              ))}
            </div>
          ) : activeCycleId ? (
            <div className="rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/40 p-4 text-center">
              <p className="text-sm text-gray-200">
                No submission in the current cycle yet.
              </p>
              <p className="text-xs text-gray-400">
                Your available slots for cycle #{activeCycleNumber} will appear here.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/40 p-4 text-center">
              <p className="text-sm text-gray-200">No current cycle right now.</p>
              <p className="text-xs text-gray-400">
                Your submissions will show up here once a new cycle starts.
              </p>
            </div>
          )}
        </div>

        <ProfileSections
          submissions={submissions}
          votes={votes}
          winnings={profileWinnings}
          commentsPreview={
            commentsPreview ? (
              <OwnCommentsList items={commentsPreview.items} />
            ) : (
              <p className="text-sm text-gray-400">Comments are temporarily unavailable.</p>
            )
          }
          mentionsPreview={
            mentionsPreview ? (
              <OwnMentionsList page={mentionsPreview} preview />
            ) : (
              <p className="text-sm text-gray-400">Mentions are temporarily unavailable.</p>
            )
          }
          savedMemesPreview={
            savedMemesPreview ? (
              <SavedMemesClient initialPage={savedMemesPreview} preview />
            ) : (
              <p className="text-sm text-gray-400">Saved memes are temporarily unavailable.</p>
            )
          }
          reportsPreview={
            reportsPreview ? (
              <OwnSubmissionReportsList
                reports={reportsPreview.items.slice(0, PROFILE_PREVIEW_LIMIT)}
              />
            ) : (
              <p className="text-sm text-gray-400">Reports are temporarily unavailable.</p>
            )
          }
          moderationHistoryPreview={
            moderationHistoryPreview ? (
              <DisqualificationHistoryList
                page={{
                  ...moderationHistoryPreview,
                  items: moderationHistoryPreview.items.slice(0, PROFILE_PREVIEW_LIMIT),
                  nextCursor: null,
                }}
                nextHref={null}
              />
            ) : (
              <p className="text-sm text-gray-400">Moderation history is temporarily unavailable.</p>
            )
          }
        />
      </div>
    </>
  );
}
