"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DiscordCooldownTimer from "@/app/components/DiscordCooldownTimer";
import DiscordSyncDelayNotice from "@/app/components/DiscordSyncDelayNotice";
import SponsoredBanner from "@/app/components/SponsoredBanner";
import SubmissionReportPanel from "@/app/components/SubmissionReportPanel";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import LoadMoreButton from "@/app/components/ui/LoadMoreButton";
import ModalCloseButton from "@/app/components/ui/ModalCloseButton";
import { DISCORD_INVITE_URL } from "@/lib/discordInvite";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";
import {
  PARTICIPATION_HOLD_TEXT,
  PARTICIPATION_HOLD_TITLE,
} from "@/lib/eligibility/participationNotice";
import type { PublicPage } from "@/lib/pagination/publicPagination";
import { usePublicPagination } from "@/lib/pagination/usePublicPagination";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import {
  resolveVoteBlockedReason,
  type VoteBlockedReason,
} from "@/lib/vote/voteEligibilityState";
import type { VoteSubmission } from "@/lib/vote/publicVoteSubmission";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "@/lib/turnstile/shared";

type Submission = VoteSubmission;

export default function SubmissionsClient({
  cycleId,
  initialActiveSubmission,
  initialPage,
  hasVoted,
  voteCount,
  votesPerUser,
  votedSubmissionIds,
  initialVoteStateAvailable,
  votingEnabled,
  isVotingClosed,
  isPaused,
  discordUserId,
  voteBlockedReason,
  voteCooldownJoinedAt,
  showDiscordSyncDelayNotice,
  sponsoredMeta,
  initialSubmissionId,
  turnstileSiteKey,
}: {
  cycleId: number;
  initialActiveSubmission: Submission | null;
  initialPage: PublicPage<Submission>;
  hasVoted: boolean;
  voteCount: number;
  votesPerUser: number;
  votedSubmissionIds: readonly number[];
  initialVoteStateAvailable: boolean;
  votingEnabled: boolean;
  isVotingClosed: boolean;
  isPaused: boolean;
  discordUserId: string | null;
  voteBlockedReason: VoteBlockedReason;
  voteCooldownJoinedAt: string | null;
  showDiscordSyncDelayNotice: boolean;
  sponsoredMeta: SponsoredCycleMeta | null;
  initialSubmissionId: number | null;
  turnstileSiteKey: string | null;
}) {
  const router = useRouter();
  const [showOriginalSize, setShowOriginalSize] = useState(false);
  const lastTapRef = useRef(0);
  const eligibilityLoadedRef = useRef(false);
  const getSubmissionKey = useCallback(
    (submission: Submission) => submission.id,
    []
  );
  const fetchPage = useCallback(
    async (cursor: string) => {
      const params = new URLSearchParams({
        cycleId: String(cycleId),
        cursor,
      });
      const response = await fetch(
        `/api/vote/submissions?${params.toString()}`,
        { cache: "no-store" }
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error ?? "LOAD_FAILED");
      }

      return data as PublicPage<Submission>;
    },
    [cycleId]
  );
  const {
    error: paginationError,
    hasMore,
    isLoading,
    items: submissions,
    loadMore,
  } = usePublicPagination({
    fetchPage,
    getKey: getSubmissionKey,
    initialPage,
  });

  function handleToggleSize() {
    setShowOriginalSize((prev) => !prev);
  }

  function handleTouchStart() {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      handleToggleSize();
    }
    lastTapRef.current = now;
  }

  const [active, setActive] = useState<Submission | null>(() =>
    initialSubmissionId
      ? initialPage.items.find(
          (submission) => submission.id === initialSubmissionId
        ) ?? initialActiveSubmission
      : null
  );
  const [voted, setVoted] = useState(hasVoted);
  const [usedVotes, setUsedVotes] = useState(voteCount);
  const [voteStateAvailable, setVoteStateAvailable] = useState(
    initialVoteStateAvailable
  );
  const [votedSubmissionIdSet, setVotedSubmissionIdSet] = useState(
    () => new Set(votedSubmissionIds)
  );
  const [localVoteBlockedReason, setLocalVoteBlockedReason] =
    useState<VoteBlockedReason | undefined>(undefined);
  const [localVoteCooldownJoinedAt, setLocalVoteCooldownJoinedAt] =
    useState<string | null | undefined>(undefined);
  const [localShowDiscordSyncDelayNotice, setLocalShowDiscordSyncDelayNotice] =
    useState<boolean | undefined>(undefined);
  const [waitingForDiscordJoin, setWaitingForDiscordJoin] =
    useState(false);
  const [isVoting, setIsVoting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [localVotes, setLocalVotes] = useState(
    Object.fromEntries(
      initialPage.items.map((s) => [s.id, s.vote_count])
    )
  );
  const effectiveVoteBlockedReason =
    resolveVoteBlockedReason(
      localVoteBlockedReason,
      voteBlockedReason
    );
  const effectiveVoteCooldownJoinedAt =
    localVoteCooldownJoinedAt ?? voteCooldownJoinedAt;
  const effectiveShowDiscordSyncDelayNotice =
    (localShowDiscordSyncDelayNotice ?? showDiscordSyncDelayNotice) &&
    (effectiveVoteBlockedReason === "not_in_discord" ||
      effectiveVoteBlockedReason === "membership_pending");

  const loadVoteEligibility = useCallback(async () => {
    if (!discordUserId) return;

    setLocalVoteBlockedReason("membership_pending");
    setLocalShowDiscordSyncDelayNotice(false);

    try {
      const response = await fetch("/api/vote/eligibility", {
        cache: "no-store",
      });
      const data = await response.json();

      if (!response.ok) {
        setVoteStateAvailable(false);
        setLocalShowDiscordSyncDelayNotice(false);
        setLocalVoteBlockedReason(
          data.status === "restricted"
            ? "banned"
            : data.status === "anonymous"
              ? "not_authenticated"
              : data.status === "temporarily_unavailable"
                ? "participation_hold"
              : "dependency_unavailable"
        );
        return;
      }

      const status = data.participation?.status;
      setLocalShowDiscordSyncDelayNotice(
        data.showDiscordSyncDelayNotice === true
      );
      setLocalVoteBlockedReason(
        status === "eligible"
          ? null
          : status === "not_in_discord"
            ? "not_in_discord"
            : status === "join_wait"
              ? "join_wait"
              : status === "restricted"
                ? "banned"
                : status === "temporarily_unavailable"
                  ? "participation_hold"
                : status === "membership_pending"
                  ? "membership_pending"
                  : "dependency_unavailable"
      );
      setLocalVoteCooldownJoinedAt(
        typeof data.participation?.joinedAt === "string"
          ? data.participation.joinedAt
          : null
      );
      setUsedVotes(typeof data.voteCount === "number" ? data.voteCount : 0);
      setVoted(data.hasVoted === true);
      setVoteStateAvailable(true);
      setVotedSubmissionIdSet(
        new Set(
          Array.isArray(data.votedSubmissionIds)
            ? data.votedSubmissionIds.filter(Number.isInteger)
            : []
        )
      );
    } catch {
      setVoteStateAvailable(false);
      setLocalShowDiscordSyncDelayNotice(false);
      setLocalVoteBlockedReason("dependency_unavailable");
    }
  }, [discordUserId]);

  useEffect(() => {
    if (
      !active ||
      !votingEnabled ||
      !discordUserId ||
      eligibilityLoadedRef.current
    ) {
      return;
    }

    eligibilityLoadedRef.current = true;
    const timeoutId = window.setTimeout(() => {
      void loadVoteEligibility();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [active, discordUserId, loadVoteEligibility, votingEnabled]);

  useEffect(() => {
    if (!waitingForDiscordJoin) return;

    const refreshSubmissionsPage = () => {
      setActive(null);
      setWaitingForDiscordJoin(false);
      setLocalVoteBlockedReason(undefined);
      setLocalVoteCooldownJoinedAt(undefined);
      setLocalShowDiscordSyncDelayNotice(undefined);
      eligibilityLoadedRef.current = false;
      router.refresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshSubmissionsPage();
      }
    };

    window.addEventListener("focus", refreshSubmissionsPage);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const timeout = window.setTimeout(refreshSubmissionsPage, 10000);

    return () => {
      window.removeEventListener("focus", refreshSubmissionsPage);
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      window.clearTimeout(timeout);
    };
  }, [router, waitingForDiscordJoin]);

  function getVoteBlockedMessage() {
    if (effectiveVoteBlockedReason === "banned") {
      return "Account restricted";
    }

    if (effectiveVoteBlockedReason === "not_in_discord") {
      return "Join Discord to vote";
    }

    if (effectiveVoteBlockedReason === "join_wait") {
      return null;
    }

    if (effectiveVoteBlockedReason === "not_authenticated") {
      return "Login with Discord to vote";
    }

    if (effectiveVoteBlockedReason === "membership_pending") {
      return "Membership verification is temporarily pending";
    }

    if (effectiveVoteBlockedReason === "participation_hold") {
      return PARTICIPATION_HOLD_TITLE;
    }

    if (effectiveVoteBlockedReason === "dependency_unavailable") {
      return "Temporarily unable to verify membership";
    }

    return null;
  }

  const voteBlockedMessage = getVoteBlockedMessage();

  async function vote(submissionId: number) {
    if (
      !votingEnabled ||
      votedSubmissionIdSet.has(submissionId) ||
      isVoting ||
      !turnstileToken
    ) {
      return;
    }

    if (effectiveVoteBlockedReason === "join_wait") {
      return;
    }

    if (effectiveVoteBlockedReason) return;

    setIsVoting(true);
    setVoteError(null);

    try {
      const fd = new FormData();
      fd.append("submissionId", String(submissionId));

      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { [TURNSTILE_TOKEN_HEADER]: turnstileToken },
        body: fd,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setTurnstileToken(null);
        setTurnstileResetKey((current) => current + 1);

        if (data?.error === "NOT_IN_DISCORD") {
          setLocalVoteBlockedReason("not_in_discord");
          setLocalShowDiscordSyncDelayNotice(false);
          void loadVoteEligibility();
          return;
        }

        if (data?.error === "JOINED_TOO_RECENTLY") {
          const joinedAt =
            typeof data.joinedAt === "string" ? data.joinedAt : null;

          setLocalVoteBlockedReason("join_wait");
          setLocalVoteCooldownJoinedAt(joinedAt);
          setLocalShowDiscordSyncDelayNotice(false);
          return;
        }

        if (data?.error === "MEMBERSHIP_PENDING") {
          setLocalVoteBlockedReason("membership_pending");
          setLocalShowDiscordSyncDelayNotice(false);
          void loadVoteEligibility();
          return;
        }

        if (data?.error === "MEMBERSHIP_UNAVAILABLE") {
          setLocalVoteBlockedReason("dependency_unavailable");
          setLocalShowDiscordSyncDelayNotice(false);
          return;
        }

        if (data?.error === "PARTICIPATION_UNAVAILABLE") {
          setLocalVoteBlockedReason("participation_hold");
          setLocalShowDiscordSyncDelayNotice(false);
          return;
        }

        setVoteError(
          data?.error === "TURNSTILE_CONFIGURATION_ERROR"
            ? "Verification is temporarily unavailable."
            : "Vote verification failed. Please try again."
        );
        return;
      }

      const data = await res.json().catch(() => null);
      const nextVoteCount =
        typeof data?.voteCount === "number"
          ? data.voteCount
          : usedVotes + 1;

      setUsedVotes(nextVoteCount);
      setVoteStateAvailable(true);
      setVoted(
        typeof data?.hasVoted === "boolean"
          ? data.hasVoted
          : nextVoteCount >= votesPerUser
      );
      setLocalVotes((v) => ({
        ...v,
        [submissionId]:
          (v[submissionId] ??
            submissions.find(
              (submission) => submission.id === submissionId
            )?.vote_count ??
            0) + 1,
      }));
      setVotedSubmissionIdSet((current) => {
        const next = new Set(current);
        next.add(submissionId);
        return next;
      });
      setActive(null);
    } catch {
      setTurnstileToken(null);
      setTurnstileResetKey((current) => current + 1);
      setVoteError("The vote could not be confirmed. Please try again.");
    } finally {
      setIsVoting(false);
    }
  }

  return (
    <>
      <div className="min-h-screen pt-20 px-6 pb-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 content-start">
        <div className="col-span-full pb-3 text-center font-['Permanent_Marker'] text-[var(--orange-main)]">
          {isPaused
            ? "CYCLE PAUSED"
            : votingEnabled
              ? voteStateAvailable
                ? `VOTING OPEN - ${usedVotes}/${votesPerUser} VOTES USED`
                : "VOTING OPEN - VOTE STATUS UNAVAILABLE"
              : isVotingClosed
                ? "VOTING CLOSED - REPORTS REMAIN OPEN"
                : "SUBMISSIONS OPEN - VOTING STARTS LATER"}
        </div>
        {submissions.map((s) => {
          const thumbSrc = getSubmissionThumbnailUrl(s.image_url);

          return (
            <button
              key={s.id}
              id={`submission-${s.id}`}
              onClick={async () => {
                setShowOriginalSize(false);
                setActive(s);
              }}
              className="group relative aspect-square overflow-hidden rounded-lg border cursor-pointer"
            >
              <Image
                src={thumbSrc}
                alt=""
                fill
                unoptimized
                sizes="(min-width: 1024px) 12.5vw, (min-width: 768px) 16.67vw, (min-width: 640px) 25vw, 33.33vw"
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
              />

              <div className="absolute bottom-0 w-full bg-black/60 text-white text-sm p-2">
                Votes: {localVotes[s.id] ?? s.vote_count}
                {s.discord_user_id === discordUserId && (
                  <span className="ml-2 opacity-70">(you)</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <LoadMoreButton
        error={paginationError}
        hasMore={hasMore}
        isLoading={isLoading}
        onLoadMore={() => void loadMore()}
      />

      {active && (
        <div
          className="fixed inset-0 z-50 bg-black/90 overflow-y-auto overscroll-contain p-6"
          onClick={() => setActive(null)}
        >
          <div
            className="relative mx-auto w-fit bg-black rounded-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <ModalCloseButton onClick={() => setActive(null)} />

            {/* eslint-disable-next-line @next/next/no-img-element -- The R2 original has unknown intrinsic dimensions, and this modal toggles between viewport-fit and native-size zoom. */}
            <img
              src={active.image_url}
              alt=""
              onDoubleClick={handleToggleSize}
              onTouchStart={handleTouchStart}
              className={
                showOriginalSize
                  ? "w-auto h-auto max-w-none mx-auto"
                  : "w-auto h-auto max-w-[75vw] max-h-[75vh] object-contain mx-auto"
              }
            />

            <div className="flex justify-center py-2">
              <button
                onClick={handleToggleSize}
                className="text-xs bg-black/50 text-white px-3 py-1 rounded-full hover:bg-black/70 cursor-pointer"
              >
                {showOriginalSize ? "Fit to Screen" : "Tap to Zoom"}
              </button>
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4 text-white">
              <span>
                Votes:{" "}
                {localVotes[active.id] ?? active.vote_count}
                {votingEnabled && votesPerUser > 1 ? (
                  <span className="ml-3 text-white/60">
                    {voteStateAvailable
                      ? `Your votes: ${usedVotes}/${votesPerUser}`
                      : "Your vote status is loading…"}
                  </span>
                ) : null}
              </span>

              <div className="flex min-w-[90px] justify-center">
                {!votingEnabled ? (
                  <span className="text-center text-xs text-white/60">
                    {isPaused ? "Cycle paused" : "Voting not open yet"}
                  </span>
                ) : active.discord_user_id !== discordUserId &&
                effectiveVoteBlockedReason === "join_wait" ? (
                  <div className="flex flex-col items-center leading-tight">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-white/55">
                      Please wait:
                    </span>
                    <DiscordCooldownTimer
                      joinedAt={effectiveVoteCooldownJoinedAt}
                      onComplete={() => {
                        eligibilityLoadedRef.current = false;
                        void loadVoteEligibility();
                      }}
                      className="font-mono text-2xl text-white"
                    />
                  </div>
                ) : null}
              </div>

              <div className="ml-auto flex items-center gap-3">
                {!votingEnabled ? (
                  <button
                    type="button"
                    disabled
                    className="cursor-not-allowed rounded bg-white/10 px-4 py-2 text-white/40"
                  >
                    Vote
                  </button>
                ) : active.discord_user_id === discordUserId ? (
                  <span className="opacity-70">
                    You cannot vote for your own submission
                  </span>
                ) : null}

                {votingEnabled &&
                  active.discord_user_id !== discordUserId &&
                  voteBlockedMessage && (
                    effectiveShowDiscordSyncDelayNotice ? (
                      <div className="max-w-sm text-center text-xs text-orange-200">
                        <DiscordSyncDelayNotice />
                        {effectiveVoteBlockedReason ===
                        "not_in_discord" ? (
                          <a
                            href={DISCORD_INVITE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setWaitingForDiscordJoin(true)}
                            className="mt-3 inline-flex rounded bg-orange-500 px-4 py-2 text-white transition hover:bg-orange-600"
                          >
                            {waitingForDiscordJoin
                              ? "Refresh after joining..."
                              : "Join Discord to Vote"}
                          </a>
                        ) : null}
                      </div>
                    ) : effectiveVoteBlockedReason === "not_in_discord" ? (
                      <a
                        href={DISCORD_INVITE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setWaitingForDiscordJoin(true)}
                        className="rounded bg-orange-500 px-4 py-2 text-white transition hover:bg-orange-600"
                      >
                        {waitingForDiscordJoin
                          ? "Refresh after joining..."
                          : "Join Discord to Vote"}
                      </a>
                    ) : effectiveVoteBlockedReason ===
                      "not_authenticated" ? (
                      <div className="max-w-56 text-center">
                        <a
                          href={`/api/auth/discord/login?state=${encodeURIComponent(`/submissions?submission=${active.id}`)}`}
                          className="inline-flex rounded bg-orange-500 px-4 py-2 text-white transition hover:bg-orange-600"
                        >
                          Login with Discord to vote
                        </a>
                        <p className="mt-2 text-[10px] text-white/55">
                          Voting requires 10 minutes of Discord membership.
                        </p>
                      </div>
                    ) : effectiveVoteBlockedReason ===
                      "participation_hold" ? (
                      <div
                        role="status"
                        className="max-w-sm text-center text-red-300"
                      >
                        <p className="font-semibold">
                          {PARTICIPATION_HOLD_TITLE}
                        </p>
                        <p className="mt-2 text-xs text-white/70">
                          {PARTICIPATION_HOLD_TEXT}
                        </p>
                      </div>
                    ) : (
                      <span className="opacity-70 text-red-400">
                        {voteBlockedMessage}
                      </span>
                    )
                  )}

                {votingEnabled &&
                  active.discord_user_id !== discordUserId &&
                  !voteBlockedMessage &&
                  votedSubmissionIdSet.has(active.id) && (
                    <span className="opacity-70">
                      You already voted for this submission
                    </span>
                  )}

                {votingEnabled &&
                  active.discord_user_id !== discordUserId &&
                  !voteBlockedMessage &&
                  !votedSubmissionIdSet.has(active.id) &&
                  !voted && (
                    <div className="flex w-full max-w-sm flex-col items-center gap-3">
                      <TurnstileWidget
                        action={TURNSTILE_ACTIONS.vote}
                        siteKey={turnstileSiteKey}
                        resetKey={turnstileResetKey}
                        onTokenChange={setTurnstileToken}
                      />
                      {voteError && (
                        <p role="alert" className="text-center text-sm text-red-300">
                          {voteError}
                        </p>
                      )}
                      <button
                        onClick={() => vote(active.id)}
                        disabled={
                          effectiveVoteBlockedReason === "join_wait" ||
                          isVoting ||
                          !turnstileToken
                        }
                        className={`rounded px-4 py-2 transition ${
                          effectiveVoteBlockedReason === "join_wait" ||
                          isVoting ||
                          !turnstileToken
                            ? "cursor-not-allowed bg-orange-500/35 text-white/45"
                            : "cursor-pointer bg-orange-500 hover:bg-orange-600"
                        }`}
                      >
                        {isVoting ? "Voting..." : "Vote"}
                      </button>
                    </div>
                  )}

                {votingEnabled &&
                  active.discord_user_id !== discordUserId &&
                  !voteBlockedMessage &&
                  !votedSubmissionIdSet.has(active.id) &&
                  voted && (
                    <span className="opacity-70">
                      You used all votes
                    </span>
                  )}
              </div>
            </div>

            <div className="px-4 pb-4 text-white">
              <SubmissionReportPanel
                isAuthenticated={discordUserId !== null}
                loginReturnPath={`/submissions?submission=${active.id}`}
                submissionId={active.id}
                surface="active"
                turnstileSiteKey={turnstileSiteKey}
              />
            </div>

            {sponsoredMeta?.enabled && sponsoredMeta.bannerUrl ? (
              <div className="px-4 pb-4">
                <div className="mx-auto w-full max-w-[316px]">
                  <SponsoredBanner
                    bannerUrl={sponsoredMeta.bannerUrl}
                    companyName={sponsoredMeta.companyName}
                    sponsorLink={sponsoredMeta.sponsorLink}
                    sponsorshipId={sponsoredMeta.sponsorshipId}
                    surface="vote_modal"
                    label="This cycle is sponsored by:"
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
