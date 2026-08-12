"use client";

import Image from "next/image";
import type { KeyboardEvent } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import SponsoredBanner from "@/app/components/SponsoredBanner";
import SubmissionReportPanel from "@/app/components/SubmissionReportPanel";
import SubmissionSocialLinks from "@/app/components/profile/SubmissionSocialLinks";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import ModalCloseButton from "@/app/components/ui/ModalCloseButton";
import type {
  CycleHistoryCycleSummaryItem,
  CycleHistorySubmission,
} from "@/lib/cycles/cycleHistoryTypes";
import {
  isSubmissionRemovedFromPublic,
  isSubmissionUnderLegalReview,
  SUBMISSION_PUBLIC_VISIBILITY,
  type SubmissionPublicVisibilityStatus,
} from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";
import type { PublicPage } from "@/lib/pagination/publicPagination";
import { mergePublicPageItems } from "@/lib/pagination/mergePublicPageItems";
import { usePublicPagination } from "@/lib/pagination/usePublicPagination";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";

const PUBLIC_VISIBILITY_REASONS = [
  "copyright_claim",
  "dmca_notice",
  "identity_rights_claim",
  "legal_review",
  "pending_verification",
] as const;

type CycleSubmissionPageState = PublicPage<CycleHistorySubmission> & {
  error: string | null;
  isLoading: boolean;
};

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
  isAdmin,
  submission,
}: {
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
      <Image
        src={getSubmissionThumbnailUrl(submission.imageUrl)}
        alt={`Cycle ${submission.cycleNumber} submission ${submission.id}`}
        width={400}
        height={224}
        unoptimized
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
  isDeepLinkTarget,
  isAdmin,
  onOpen,
  submission,
}: {
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
  isAuthenticated,
  isAdmin,
  onClose,
  submission,
  sponsoredMeta,
  turnstileSiteKey,
}: {
  canModerate: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  onClose: () => void;
  submission: CycleHistorySubmission;
  sponsoredMeta: SponsoredCycleMeta | null;
  turnstileSiteKey: string | null;
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
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- The R2 original has unknown intrinsic dimensions, and this modal toggles between viewport-fit and native-size zoom. */}
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
          </>
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
                Cycle #{submission.cycleNumber}
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

          {!submission.isDisqualified &&
          !isSubmissionRemovedFromPublic(
            submission.publicVisibilityStatus
          ) ? (
            <SubmissionReportPanel
              isAuthenticated={isAuthenticated}
              loginReturnPath={`/cycle-history?cycle=${submission.cycleId}#submission-${submission.id}`}
              submissionId={submission.id}
              surface="history"
              reportingOpen
              turnstileSiteKey={turnstileSiteKey}
            />
          ) : null}

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
  initialPage,
  isAdmin,
  isAuthenticated,
  turnstileSiteKey,
}: {
  canModerate: boolean;
  initialPage: PublicPage<CycleHistoryCycleSummaryItem>;
  isAdmin: boolean;
  isAuthenticated: boolean;
  turnstileSiteKey: string | null;
}) {
  const getCycleKey = useCallback(
    (cycle: CycleHistoryCycleSummaryItem) => cycle.id,
    []
  );
  const fetchCycles = useCallback(async (cursor: string) => {
    const response = await fetch(
      `/api/cycle-history?cursor=${encodeURIComponent(cursor)}`,
      { cache: "no-store" }
    );
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error ?? "LOAD_FAILED");
    }

    return data as PublicPage<CycleHistoryCycleSummaryItem>;
  }, []);
  const {
    error: cyclesError,
    hasMore: hasMoreCycles,
    isLoading: isLoadingCycles,
    items: cycles,
    loadMore: loadMoreCycles,
    loadUntil: loadCyclesUntil,
  } = usePublicPagination({
    fetchPage: fetchCycles,
    getKey: getCycleKey,
    initialPage,
  });
  const [activeSubmission, setActiveSubmission] =
    useState<CycleHistorySubmission | null>(null);
  const [expandedCycleIds, setExpandedCycleIds] = useState<
    number[]
  >(
    initialPage.items.length > 0
      ? [initialPage.items[0].id]
      : []
  );
  const [deepLinkedSubmissionId, setDeepLinkedSubmissionId] =
    useState<number | null>(null);
  const [cyclePages, setCyclePages] = useState<
    Record<number, CycleSubmissionPageState>
  >({});
  const loadingCycleIdsRef = useRef(new Set<number>());
  const hasScrolledToDeepLink = useRef(false);

  const fetchCyclePage = useCallback(
    async (cycleId: number, cursor?: string | null) => {
      const params = new URLSearchParams();

      if (cursor) {
        params.set("cursor", cursor);
      }

      const suffix = params.size > 0 ? `?${params}` : "";
      const response = await fetch(
        `/api/cycle-history/${cycleId}${suffix}`,
        { cache: "no-store" }
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ?? "Failed to load cycle submissions"
        );
      }

      return data as PublicPage<CycleHistorySubmission>;
    },
    []
  );

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

    async function openInitialCycle() {
      const targetCycle =
        Number.isSafeInteger(targetCycleId) &&
        targetCycleId > 0
          ? cycles.find(
              (cycle) => cycle.id === targetCycleId
            ) ??
            (await loadCyclesUntil(
              (cycle) => cycle.id === targetCycleId
            ))
          : null;

      if (!targetCycle) {
        void loadCycle(cycles[0].id, null);
        return;
      }

      setExpandedCycleIds((previous) =>
        previous.includes(targetCycleId)
          ? previous
          : [...previous, targetCycleId]
      );
      setDeepLinkedSubmissionId(targetSubmissionId);
      void loadCycle(targetCycleId, targetSubmissionId);
    }

    void openInitialCycle();

    if (
      targetSubmissionId &&
      Number.isInteger(targetSubmissionId)
    ) {
      setDeepLinkedSubmissionId(targetSubmissionId);
    }
    // Initial deep links may traverse bounded pages until their cycle is found.
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
  }, [cyclePages, deepLinkedSubmissionId]);

  async function loadCycle(
    cycleId: number,
    targetSubmissionId: number | null = null
  ) {
    if (cyclePages[cycleId] && !cyclePages[cycleId].error) {
      return;
    }

    if (loadingCycleIdsRef.current.has(cycleId)) {
      return;
    }

    loadingCycleIdsRef.current.add(cycleId);
    setCyclePages((previous) => ({
      ...previous,
      [cycleId]: {
        items: previous[cycleId]?.items ?? [],
        nextCursor: previous[cycleId]?.nextCursor ?? null,
        hasMore: previous[cycleId]?.hasMore ?? false,
        error: null,
        isLoading: true,
      },
    }));

    try {
      let page = await fetchCyclePage(cycleId);
      let items = page.items;

      while (
        targetSubmissionId &&
        !items.some(
          (submission) =>
            submission.id === targetSubmissionId
        ) &&
        page.hasMore &&
        page.nextCursor
      ) {
        page = await fetchCyclePage(
          cycleId,
          page.nextCursor
        );
        items = mergePublicPageItems(
          items,
          page.items,
          (submission) => submission.id
        );
      }

      setCyclePages((previous) => ({
        ...previous,
        [cycleId]: {
          ...page,
          items,
          error: null,
          isLoading: false,
        },
      }));
    } catch {
      setCyclePages((previous) => ({
        ...previous,
        [cycleId]: {
          items: previous[cycleId]?.items ?? [],
          nextCursor: previous[cycleId]?.nextCursor ?? null,
          hasMore: previous[cycleId]?.hasMore ?? false,
          error: "Could not load this cycle. Please try again.",
          isLoading: false,
        },
      }));
    } finally {
      loadingCycleIdsRef.current.delete(cycleId);
    }
  }

  async function loadMoreCycle(cycleId: number) {
    const current = cyclePages[cycleId];

    if (
      !current?.hasMore ||
      !current.nextCursor ||
      loadingCycleIdsRef.current.has(cycleId)
    ) {
      return;
    }

    loadingCycleIdsRef.current.add(cycleId);
    setCyclePages((previous) => ({
      ...previous,
      [cycleId]: {
        ...previous[cycleId],
        error: null,
        isLoading: true,
      },
    }));

    try {
      const page = await fetchCyclePage(
        cycleId,
        current.nextCursor
      );

      setCyclePages((previous) => ({
        ...previous,
        [cycleId]: {
          ...page,
          items: mergePublicPageItems(
            previous[cycleId]?.items ?? [],
            page.items,
            (submission) => submission.id
          ),
          error: null,
          isLoading: false,
        },
      }));
    } catch {
      setCyclePages((previous) => ({
        ...previous,
        [cycleId]: {
          ...previous[cycleId],
          error: "Could not load more. Please try again.",
          isLoading: false,
        },
      }));
    } finally {
      loadingCycleIdsRef.current.delete(cycleId);
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
          const cyclePage = cyclePages[cycle.id];
          const submissions = cyclePage?.items ?? [];
          const isExpanded = expandedCycleIds.includes(cycle.id);
          const isLoading = cyclePage?.isLoading === true;
          const sponsoredMeta = cycle.sponsoredMeta;
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
                    Cycle #{cycle.cycleNumber}
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
                {isLoading && submissions.length === 0 ? (
                  <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
                    Loading submissions...
                  </div>
                ) : submissions.length > 0 ? (
                  <>
                    <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {submissions.map((submission) => (
                        <SubmissionCard
                          key={submission.id}
                          isDeepLinkTarget={
                            submission.id === deepLinkedSubmissionId
                          }
                          isAdmin={isAdmin}
                          submission={submission}
                          onOpen={setActiveSubmission}
                        />
                      ))}
                    </div>
                    <LoadMoreButton
                      error={cyclePage?.error ?? null}
                      hasMore={cyclePage?.hasMore ?? false}
                      isLoading={isLoading}
                      onLoadMore={() =>
                        void loadMoreCycle(cycle.id)
                      }
                    />
                  </>
                ) : cyclePage?.error ? (
                  <LoadMoreButton
                    error={cyclePage.error}
                    hasMore
                    isLoading={false}
                    onLoadMore={() => void loadCycle(cycle.id)}
                  />
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

      <LoadMoreButton
        error={cyclesError}
        hasMore={hasMoreCycles}
        isLoading={isLoadingCycles}
        onLoadMore={() => void loadMoreCycles()}
      />

      {activeSubmission && (
        <SubmissionModal
          canModerate={canModerate}
          isAuthenticated={isAuthenticated}
          isAdmin={isAdmin}
          submission={activeSubmission}
          sponsoredMeta={
            cycles.find(
              (cycle) => cycle.id === activeSubmission.cycleId
            )?.sponsoredMeta ?? null
          }
          turnstileSiteKey={turnstileSiteKey}
          onClose={() => setActiveSubmission(null)}
        />
      )}
    </>
  );
}
