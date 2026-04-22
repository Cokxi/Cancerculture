"use client";

import type { KeyboardEvent } from "react";
import { useRef, useState } from "react";
import ProfileLinkButton from "@/app/components/profile/ProfileLinkButton";
import type {
  CycleHistoryCycle,
  CycleHistorySubmission,
} from "@/lib/cycles/getCycleHistoryData";
import { formatReason } from "@/lib/profile/formatReason";

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

function SubmissionCard({
  cycleId,
  onOpen,
  submission,
}: {
  cycleId: number;
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
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className="cursor-pointer rounded-xl border border-white/10 bg-black/40 p-4 text-left transition hover:border-[var(--orange-dark)]/50"
    >
      {submission.imageUrl ? (
        <img
          src={submission.imageUrl}
          alt={`Cycle ${cycleId} submission ${submission.id}`}
          className="h-56 w-full rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-56 w-full items-center justify-center rounded-lg bg-orange-200/20 text-4xl">
          ?
        </div>
      )}

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
              Wallet: {submission.winnerProfile.wallet_address}
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
  onClose,
  submission,
}: {
  onClose: () => void;
  submission: CycleHistorySubmission;
}) {
  const [showOriginalSize, setShowOriginalSize] =
    useState(false);
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

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/90 p-6"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close modal"
        className="fixed top-4 right-4 z-[60] flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-black/60 text-2xl text-white hover:bg-black/80"
      >
        ×
      </button>

      <div
        className="relative mx-auto w-fit rounded-xl bg-black"
        onClick={(event) => event.stopPropagation()}
      >
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
          <div className="flex h-[60vh] w-[60vw] items-center justify-center rounded-lg bg-orange-200/20 text-4xl">
            ?
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
          <div className="flex items-center justify-between gap-3">
            <div className="text-lg font-semibold">
              Cycle #{submission.cycleId}
            </div>
            {submission.isWinner && (
              <span className="rounded-full bg-green-500/15 px-3 py-1 text-xs text-green-300">
                Winner
              </span>
            )}
          </div>

          <div className="text-sm opacity-80">
            Votes: {submission.voteCount}
          </div>

          <div className="text-sm opacity-80">
            Rank: {submission.rank ?? "-"}
          </div>

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
                Wallet: {submission.winnerProfile.wallet_address}
              </div>
              <div className="mt-1 text-xs">
                {formatPayoutChoice(submission)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CycleHistoryClient({
  cycles,
}: {
  cycles: CycleHistoryCycle[];
}) {
  const [activeSubmission, setActiveSubmission] =
    useState<CycleHistorySubmission | null>(null);

  return (
    <>
      <div className="space-y-6">
        {cycles.map((cycle, index) => (
          <details
            key={cycle.id}
            open={index === 0}
            className="rounded-2xl border border-orange-500/30 bg-black/50 p-5"
          >
            <summary className="cursor-pointer list-none">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-2xl font-[Permanent_Marker] text-[var(--orange-dark)]">
                    Cycle #{cycle.id}
                  </h2>
                  <p className="mt-1 text-sm text-white/70">
                    Theme: {cycle.theme ?? "Open Round"}
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
                    Submissions: {cycle.submissions.length}
                  </div>
                </div>
              </div>
            </summary>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {cycle.submissions.map((submission) => (
                <SubmissionCard
                  key={submission.id}
                  cycleId={cycle.id}
                  submission={submission}
                  onOpen={setActiveSubmission}
                />
              ))}
            </div>
          </details>
        ))}
      </div>

      {activeSubmission && (
        <SubmissionModal
          submission={activeSubmission}
          onClose={() => setActiveSubmission(null)}
        />
      )}
    </>
  );
}
