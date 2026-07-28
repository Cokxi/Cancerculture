"use client";

import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import SponsoredBanner from "@/app/components/SponsoredBanner";
import SubmissionSocialLinks from "@/app/components/profile/SubmissionSocialLinks";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import ModalCloseButton from "@/app/components/ui/ModalCloseButton";
import type {
  CycleHistoryCycle,
  CycleHistoryCycleSummary,
  CycleHistorySubmission,
} from "@/lib/cycles/getCycleHistoryData";
import {
  isSubmissionRemovedFromPublic,
  isSubmissionUnderLegalReview,
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";

const PUBLIC_VISIBILITY_REASONS = [
  "copyright_claim",
  "dmca_notice",
  "identity_rights_claim",
  "legal_review",
  "pending_verification",
] as const;

function formatPayoutChoice(
  submission: CycleHistorySubmission
) {
  const winnerProfile = submission.winnerProfile;

  if (!winnerProfile) {
    return null;
  }

  if (winnerProfile.payout_choice === "keep") {
    return "Payout choice: keep";
  }

  if (winnerProfile.payout_choice === "donate") {
    return `Payout choice: donate to ${
      winnerProfile.charity ?? "selected charity"
    }`;
  }

  if (
    winnerProfile.payout_choice === "split" &&
    winnerProfile.split_percent !== null
  ) {
    const charityPercent =
      100 - winnerProfile.split_percent;
    const payoutRecipient =
      submission.discordUsername || "user";

    return `Payout choice: split (${winnerProfile.split_percent}% to ${payoutRecipient}, ${charityPercent}% to ${
      winnerProfile.charity ?? "selected charity"
    })`;
  }

  return `Payout choice: ${winnerProfile.payout_choice}`;
}

function formatWalletValue(
  walletAddress: string,
  payoutChoice: string
) {
  if (walletAddress) {
    return walletAddress;
  }

  if (payoutChoice === "donate") {
    return "No wallet required for full donation";
  }

  return "Not provided";
}

function formatPublicVisibilityStatus(
  status: SubmissionPublicVisibilityStatus
) {
  if (status === SUBMISSION_PUBLIC_VISIBILITY.legalReview) {
    return "Temporarily hidden pending legal review";
  }

  if (status === SUBMISSION_PUBLIC_VISIBILITY.removed) {
    return "Removed from public archive";
  }

  return "Visible";
}

function PublicVisibilityBanner({
  submission,
}: {
  submission: CycleHistorySubmission;
}) {
  if (
    submission.publicVisibilityStatus ===
    SUBMISSION_PUBLIC_VISIBILITY.visible
  ) {
    return null;
  }

  const isLegalReview = isSubmissionUnderLegalReview(
    submission.publicVisibilityStatus
  );

  return (
    <div
      className={`rounded-lg p-3 text-sm ${
        isLegalReview
          ? "bg-yellow-500/10 text-yellow-200"
          : "bg-red-500/10 text-red-300"
      }`}
    >
      <div className="font-semibold">
        {formatPublicVisibilityStatus(
          submission.publicVisibilityStatus
        )}
      </div>

      {submission.publicVisibilityReasonCode && (
        <div className="mt-1 text-xs">
          {formatReason(
            submission.publicVisibilityReasonCode
          )}
        </div>
      )}

      {submission.publicVisibilityReasonText && (
        <div className="mt-1 text-xs">
          {submission.publicVisibilityReasonText}
        </div>
      )}
    </div>
  );
}

function SubmissionPreview({
  cycleId,
  isAdmin,
  submission,
}: {
  cycleId: number;
  isAdmin: boolean;
  submission: CycleHistorySubmission;
}) {
  const showPlaceholder =
    !submission.imageUrl ||
    (!isAdmin &&
      isSubmissionUnderLegalReview(
        submission.publicVisibilityStatus
      ));

  if (!showPlaceholder && submission.imageUrl) {
    return (
      <img
        src={submission.imageUrl}
        alt={`Cycle ${cycleId} submission ${submission.id}`}
        className="h-56 w-full rounded-lg object-cover"
      />
    );
  }

  return (
    <div className="flex h-56 w-full flex-col items-center justify-center rounded-lg bg-orange-200/20 px-4 text-center">
      <div className="text-4xl">
        {isSubmissionRemovedFromPublic(
          submission.publicVisibilityStatus
        )
          ? "-"
          : "?"}
      </div>
      <div className="mt-2 text-sm text-white/80">
        {submission.publicVisibilityStatus ===
        SUBMISSION_PUBLIC_VISIBILITY.visible
          ? "Preview unavailable"
          : formatPublicVisibilityStatus(
              submission.publicVisibilityStatus
            )}
      </div>
    </div>
  );
}

function SubmissionCard({
  cycleId,
  isDeepLinkTarget,
  isAdmin,
  onOpen,
  submission,
}: {
  cycleId: number;
  isDeepLinkTarget: boolean;
  isAdmin: boolean;
  onOpen: (submission: CycleHistorySubmission) => void;
  submission: CycleHistorySubmission;
}) {
  function handleActivate() {
    onOpen(submission);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleActivate();
    }
  }

  return (
    <div
      id={`submission-${submission.id}`}
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className={`scroll-mt-24 cursor-pointer rounded-xl border bg-black/40 p-4 text-left transition hover:border-[var(--orange-dark)]/50 ${
        isDeepLinkTarget
          ? "border-[var(--orange-dark)] shadow-[0_0_24px_rgba(255,95,31,0.35)]"
          : "border-white/10"
      }`}
    >
      <SubmissionPreview
        cycleId={cycleId}
        isAdmin={isAdmin}
        submission={submission}
      />

      <div className="mt-4 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="font-semibold text-white">
            <ProfileLinkButton
              currentUsername={submission.discordUsername}
              profileId={submission.publicProfileId}
            />
          </div>

          {submission.isWinner && (
            <span className="rounded-full bg-green-500/15 px-3 py-1 text-xs text-green-300">
              Winner
            </span>
          )}
        </div>

        <div className="text-white/70">
          Votes: {submission.voteCount}
        </div>

        <div className="text-white/70">
          Rank: {submission.rank ?? "-"}
        </div>

        <PublicVisibilityBanner submission={submission} />

        {submission.isDisqualified ? (
          <div className="rounded-lg bg-red-500/10 p-3 text-red-300">
            <div className="font-semibold">
              Disqualified
            </div>
            {submission.disqualificationReasonCode && (
              <div className="mt-1 text-xs">
                {formatReason(
                  submission.disqualificationReasonCode
                )}
              </div>
            )}
            {submission.disqualificationReasonText && (
              <div className="mt-1 text-xs">
                {submission.disqualificationReasonText}
              </div>
            )}
          </div>
        ) : null}

        {submission.winnerProfile && (
          <div className="rounded-lg bg-white/5 p-3 text-white/80">
            <div className="font-semibold text-[var(--orange-dark)]">
              Winner Transparency
            </div>
            <div className="mt-2 break-all text-xs">
              Wallet:{" "}
              {formatWalletValue(
                submission.winnerProfile.wallet_address,
                submission.winnerProfile.payout_choice
              )}
            </div>
            <div className="mt-1 text-xs">
              {formatPayoutChoice(submission)}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function SubmissionModal({
  canModerate,
  isAdmin,
  onClose,
  submission,
  sponsoredMeta,
}: {
  canModerate: boolean;
  isAdmin: boolean;
  onClose: () => void;
  submission: CycleHistorySubmission;
  sponsoredMeta: SponsoredCycleMeta | null;
}) {
  const [showOriginalSize, setShowOriginalSize] =
    useState(false);
  const [reasonCode, setReasonCode] = useState(
    submission.publicVisibilityReasonCode ??
      PUBLIC_VISIBILITY_REASONS[0]
  );
  const [reasonText, setReasonText] = useState(
    submission.publicVisibilityReasonText ?? ""
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastTapRef = useRef(0);

  function handleToggleSize() {
    setShowOriginalSize((previous) => !previous);
  }

  function handleTouchStart() {
    const now = Date.now();

    if (now - lastTapRef.current < 300) {
      handleToggleSize();
    }

    lastTapRef.current = now;
  }

  async function handlePublicVisibilityChange(
    status: SubmissionPublicVisibilityStatus
  ) {
    if (
      status !== SUBMISSION_PUBLIC_VISIBILITY.visible &&
      !reasonCode
    ) {
      window.alert("Please select a reason first.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(
        "/api/admin/submissions/public-visibility",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            submissionId: submission.id,
            status,
            reasonCode:
              status === SUBMISSION_PUBLIC_VISIBILITY.visible
                ? null
                : reasonCode,
            reasonText:
              status === SUBMISSION_PUBLIC_VISIBILITY.visible
                ? null
                : reasonText || null,
          }),
        }
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ?? "Visibility update failed"
        );
      }

      window.location.reload();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Visibility update failed"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/90 p-6"
      onClick={onClose}
    >
      <div
        className="relative mx-auto w-fit rounded-xl bg-black"
        onClick={(event) => event.stopPropagation()}
      >
        <ModalCloseButton onClick={onClose} />

        {submission.imageUrl ? (
          <img
            src={submission.imageUrl}
            alt=""
            onDoubleClick={handleToggleSize}
            onTouchStart={handleTouchStart}
            className={
              showOriginalSize
                ? "mx-auto h-auto w-auto max-w-none rounded-lg"
                : "mx-auto h-auto max-h-[75vh] w-auto max-w-[75vw] rounded-lg object-contain"
            }
          />
        ) : (
          <div className="flex h-[60vh] w-[60vw] min-w-[280px] items-center justify-center rounded-lg bg-orange-200/20 px-6 text-center">
            <div>
              <div className="text-4xl">
                {isSubmissionRemovedFromPublic(
                  submission.publicVisibilityStatus
                )
                  ? "-"
                  : "?"}
              </div>
              <div className="mt-3 text-sm text-white/80">
                {submission.publicVisibilityStatus ===
                SUBMISSION_PUBLIC_VISIBILITY.visible
                  ? "Preview unavailable"
                  : formatPublicVisibilityStatus(
                      submission.publicVisibilityStatus
                    )}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-center pb-2">
          <button
            type="button"
            onClick={handleToggleSize}
            className="cursor-pointer rounded-full bg-black/50 px-3 py-1 text-xs text-white hover:bg-black/70"
          >
            {showOriginalSize
              ? "Fit to Screen"
              : "Tap to Zoom"}
          </button>
        </div>

        <div className="space-y-3 p-4 text-white">
          {submission.isWinner && (
            <div className="flex justify-end">
              <span className="rounded-full bg-green-500/15 px-3 py-1 text-xs text-green-300">
                Winner
              </span>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_316px] md:items-start">
            <div className="space-y-3">
              <div className="text-lg font-semibold">
                Cycle #{submission.cycleId}
              </div>

              <div className="text-sm opacity-80">
                Votes: {submission.voteCount}
              </div>

              <div className="text-sm opacity-80">
                Rank: {submission.rank ?? "-"}
              </div>

              <PublicVisibilityBanner submission={submission} />

              <div className="text-sm opacity-80">
                <strong>User:</strong>{" "}
                <ProfileLinkButton
                  currentUsername={submission.discordUsername}
                  profileId={submission.publicProfileId}
                />
              </div>

              {submission.isDisqualified && (
                <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
                  <div className="font-semibold">
                    Disqualified
                  </div>
                  {submission.disqualificationReasonCode && (
                    <div className="mt-1 text-xs">
                      {formatReason(
                        submission.disqualificationReasonCode
                      )}
                    </div>
                  )}
                  {submission.disqualificationReasonText && (
                    <div className="mt-1 text-xs">
                      {submission.disqualificationReasonText}
                    </div>
                  )}
                </div>
              )}

              {submission.winnerProfile && (
                <div className="rounded-lg bg-white/5 p-3 text-sm text-white/80">
                  <div className="font-semibold text-[var(--orange-dark)]">
                    Winner Transparency
                  </div>
                  <div className="mt-2 break-all text-xs">
                    Wallet:{" "}
                    {formatWalletValue(
                      submission.winnerProfile.wallet_address,
                      submission.winnerProfile.payout_choice
                    )}
                  </div>
                  <div className="mt-1 text-xs">
                    {formatPayoutChoice(submission)}
                  </div>
                </div>
              )}

            </div>

            {sponsoredMeta?.enabled && sponsoredMeta.bannerUrl ? (
              <div className="md:pt-1">
                <SponsoredBanner
                  bannerUrl={sponsoredMeta.bannerUrl}
                  companyName={sponsoredMeta.companyName}
                  sponsorLink={sponsoredMeta.sponsorLink}
                  sponsorshipId={sponsoredMeta.sponsorshipId}
                  surface="history_modal"
                  label="Sponsored by:"
                />
              </div>
            ) : null}
          </div>

          {submission.socialLinks.length > 0 && (
            <SubmissionSocialLinks
              socials={submission.socialLinks}
              className="mx-auto w-full max-w-md"
            />
          )}

          {canModerate && (
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <div className="font-semibold text-[var(--orange-dark)]">
                Visibility controls
              </div>

              <div className="mt-3 space-y-3">
                <div className="rounded-lg bg-black/30 p-3 text-xs text-white/70">
                  <div>
                    <strong className="text-white/90">
                      Current status:
                    </strong>{" "}
                    {formatPublicVisibilityStatus(
                      submission.publicVisibilityStatus
                    )}
                  </div>

                  {submission.publicVisibilityUpdatedAt && (
                    <div className="mt-1">
                      <strong className="text-white/90">
                        Visibility updated:
                      </strong>{" "}
                      {new Date(
                        submission.publicVisibilityUpdatedAt
                      ).toLocaleString()}
                    </div>
                  )}

                  {submission.publicVisibilityUpdatedByDiscordUsername && (
                    <div className="mt-1">
                      <strong className="text-white/90">
                        By:
                      </strong>{" "}
                      {
                        submission.publicVisibilityUpdatedByDiscordUsername
                      }
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs text-white/70">
                    Reason
                  </label>
                  <select
                    value={reasonCode}
                    onChange={(event) =>
                      setReasonCode(event.target.value)
                    }
                    className="w-full rounded-lg border border-white/10 bg-black/60 px-3 py-2 text-sm text-white"
                  >
                    {PUBLIC_VISIBILITY_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {formatReason(reason)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-xs text-white/70">
                    Internal / public note
                  </label>
                  <textarea
                    rows={3}
                    value={reasonText}
                    onChange={(event) =>
                      setReasonText(event.target.value)
                    }
                    className="w-full rounded-lg border border-white/10 bg-black/60 px-3 py-2 text-sm text-white"
                    placeholder="Optional details for the moderation trail"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = `/api/admin/submissions/${submission.id}/export`;
                      }}
                      className="rounded-full border border-white/15 bg-white/5 px-3 py-2 text-xs text-white disabled:opacity-50"
                    >
                      Export Audit JSON
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() =>
                      handlePublicVisibilityChange(
                        SUBMISSION_PUBLIC_VISIBILITY.legalReview
                      )
                    }
                    className="rounded-full border border-yellow-400/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200 disabled:opacity-50"
                  >
                    Mark Legal Review
                  </button>

                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() =>
                          handlePublicVisibilityChange(
                            SUBMISSION_PUBLIC_VISIBILITY.removed
                          )
                        }
                        className="rounded-full border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200 disabled:opacity-50"
                      >
                        Remove from Public
                      </button>

                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() =>
                          handlePublicVisibilityChange(
                            SUBMISSION_PUBLIC_VISIBILITY.visible
                          )
                        }
                        className="rounded-full border border-green-400/40 bg-green-500/10 px-3 py-2 text-xs text-green-200 disabled:opacity-50"
                      >
                        Restore Public
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CycleHistoryClient({
  canModerate,
  cycles,
  isAdmin,
  sponsoredMetaByCycleId,
}: {
  canModerate: boolean;
  cycles: CycleHistoryCycleSummary[];
  isAdmin: boolean;
  sponsoredMetaByCycleId: Record<number, SponsoredCycleMeta | null>;
}) {
  const [activeSubmission, setActiveSubmission] =
    useState<CycleHistorySubmission | null>(null);
  const [expandedCycleIds, setExpandedCycleIds] = useState<
    number[]
  >(cycles.length > 0 ? [cycles[0].id] : []);
  const [deepLinkedSubmissionId, setDeepLinkedSubmissionId] =
    useState<number | null>(null);
  const [cycleDetails, setCycleDetails] = useState<
    Record<number, CycleHistoryCycle>
  >({});
  const [loadingCycleIds, setLoadingCycleIds] = useState<
    number[]
  >([]);
  const hasScrolledToDeepLink = useRef(false);

  useEffect(() => {
    if (cycles.length === 0) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const targetCycleId = Number(params.get("cycle"));
    const hashMatch = window.location.hash.match(
      /^#submission-(\d+)$/
    );
    const targetSubmissionId = hashMatch
      ? Number(hashMatch[1])
      : null;

    if (
      Number.isInteger(targetCycleId) &&
      cycles.some((cycle) => cycle.id === targetCycleId)
    ) {
      setExpandedCycleIds((previous) =>
        previous.includes(targetCycleId)
          ? previous
          : [...previous, targetCycleId]
      );
      void loadCycle(targetCycleId);
    } else {
      void loadCycle(cycles[0].id);
    }

    if (
      targetSubmissionId &&
      Number.isInteger(targetSubmissionId)
    ) {
      setDeepLinkedSubmissionId(targetSubmissionId);
    }
    // We only want the initial cycle to prefetch on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!deepLinkedSubmissionId || hasScrolledToDeepLink.current) {
      return;
    }

    const target = document.getElementById(
      `submission-${deepLinkedSubmissionId}`
    );

    if (!target) {
      return;
    }

    hasScrolledToDeepLink.current = true;
    target.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [cycleDetails, deepLinkedSubmissionId]);

  async function loadCycle(cycleId: number) {
    if (cycleDetails[cycleId]) {
      return;
    }

    if (loadingCycleIds.includes(cycleId)) {
      return;
    }

    setLoadingCycleIds((previous) => [...previous, cycleId]);

    try {
      const response = await fetch(
        `/api/cycle-history/${cycleId}`
      );
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.cycle) {
        throw new Error(
          data?.error ?? "Failed to load cycle details"
        );
      }

      setCycleDetails((previous) => ({
        ...previous,
        [cycleId]: data.cycle,
      }));
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to load cycle details"
      );
    } finally {
      setLoadingCycleIds((previous) =>
        previous.filter((id) => id !== cycleId)
      );
    }
  }

  function handleToggle(cycleId: number, isOpen: boolean) {
    if (isOpen) {
      setExpandedCycleIds((previous) =>
        previous.includes(cycleId)
          ? previous
          : [...previous, cycleId]
      );
      void loadCycle(cycleId);
      return;
    }

    setExpandedCycleIds((previous) =>
      previous.filter((id) => id !== cycleId)
    );
  }

  return (
    <>
      <div className="space-y-6">
        {cycles.map((cycle) => {
          const cycleDetail = cycleDetails[cycle.id];
          const submissions = cycleDetail?.submissions ?? [];
          const isExpanded = expandedCycleIds.includes(cycle.id);
          const isLoading = loadingCycleIds.includes(cycle.id);
          const sponsoredMeta =
            sponsoredMetaByCycleId[cycle.id] ?? null;
          const isSponsored =
            sponsoredMeta?.enabled === true &&
            Boolean(sponsoredMeta.bannerUrl);

          return (
          <details
            key={cycle.id}
            open={isExpanded}
            onToggle={(event) =>
              handleToggle(
                cycle.id,
                (event.currentTarget as HTMLDetailsElement)
                  .open
              )
            }
            className="rounded-2xl border border-orange-500/30 bg-black/50 p-5"
          >
            <summary className="cursor-pointer list-none">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-2xl font-[Permanent_Marker] text-[var(--orange-dark)]">
                    Cycle #{cycle.id}
                  </h2>
                  <p className="mt-1 text-sm text-white/70">
                    Theme: {cycle.theme ?? "Open Cycle"}
                    {isSponsored ? (
                      <span className="ml-2 text-[var(--orange-dark)]">
                        (Sponsored)
                      </span>
                    ) : null}
                  </p>
                </div>

                <div className="text-sm text-white/60">
                  <div>
                    Started:{" "}
                    {cycle.startedAt
                      ? new Date(
                          cycle.startedAt
                        ).toLocaleString()
                      : "Unknown"}
                  </div>
                  <div>
                    Ended:{" "}
                    {cycle.endedAt
                      ? new Date(
                          cycle.endedAt
                        ).toLocaleString()
                      : "Unknown"}
                  </div>
                  <div>
                    Submissions: {cycle.submissionCount}
                  </div>
                </div>
              </div>
            </summary>

            {isExpanded && (
              <>
                {isLoading ? (
                  <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
                    Loading submissions...
                  </div>
                ) : submissions.length > 0 ? (
                  <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {submissions.map((submission) => (
                      <SubmissionCard
                        key={submission.id}
                        cycleId={cycle.id}
                        isDeepLinkTarget={
                          submission.id === deepLinkedSubmissionId
                        }
                        isAdmin={isAdmin}
                        submission={submission}
                        onOpen={setActiveSubmission}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
                    No submissions available for this cycle.
                  </div>
                )}
              </>
            )}
          </details>
          );
        })}
      </div>

      {activeSubmission && (
        <SubmissionModal
          canModerate={canModerate}
          isAdmin={isAdmin}
          submission={activeSubmission}
          sponsoredMeta={
            sponsoredMetaByCycleId[activeSubmission.cycleId] ??
            null
          }
          onClose={() => setActiveSubmission(null)}
        />
      )}
    </>
  );
}
