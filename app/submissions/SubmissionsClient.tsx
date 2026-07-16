"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DiscordCooldownTimer from "@/app/components/DiscordCooldownTimer";
import SponsoredBanner from "@/app/components/SponsoredBanner";
import { DISCORD_INVITE_URL } from "@/lib/discordInvite";
import type { SponsoredCycleMeta } from "@/lib/cycles/sponsoredCycle";

type Submission = {
  id: number;
  image_url: string;
  vote_count: number;
  discord_user_id: string;
};

type VoteBlockedReason =
  | "banned"
  | "not_in_discord"
  | "joined_too_recently"
  | null;

export default function SubmissionsClient({
  submissions,
  hasVoted,
  voteCount,
  votesPerUser,
  votedSubmissionIds,
  votingEnabled,
  isPaused,
  discordUserId,
  voteBlockedReason,
  voteCooldownJoinedAt,
  sponsoredMeta,
  initialSubmissionId,
}: {
  submissions: Submission[];
  hasVoted: boolean;
  voteCount: number;
  votesPerUser: number;
  votedSubmissionIds: number[];
  votingEnabled: boolean;
  isPaused: boolean;
  discordUserId: string;
  voteBlockedReason: VoteBlockedReason;
  voteCooldownJoinedAt: string | null;
  sponsoredMeta: SponsoredCycleMeta | null;
  initialSubmissionId: number | null;
}) {
  const router = useRouter();
  const [showOriginalSize, setShowOriginalSize] = useState(false);
  const lastTapRef = useRef(0);

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
      ? submissions.find(
          (submission) => submission.id === initialSubmissionId
        ) ?? null
      : null
  );
  const [voted, setVoted] = useState(hasVoted);
  const [usedVotes, setUsedVotes] = useState(voteCount);
  const [votedSubmissionIdSet, setVotedSubmissionIdSet] = useState(
    () => new Set(votedSubmissionIds)
  );
  const [localVoteBlockedReason, setLocalVoteBlockedReason] =
    useState<VoteBlockedReason | undefined>(undefined);
  const [localVoteCooldownJoinedAt, setLocalVoteCooldownJoinedAt] =
    useState<string | null | undefined>(undefined);
  const [waitingForDiscordJoin, setWaitingForDiscordJoin] =
    useState(false);
  const [localVotes, setLocalVotes] = useState(
    Object.fromEntries(submissions.map((s) => [s.id, s.vote_count]))
  );
  const effectiveVoteBlockedReason =
    localVoteBlockedReason ?? voteBlockedReason;
  const effectiveVoteCooldownJoinedAt =
    localVoteCooldownJoinedAt ?? voteCooldownJoinedAt;

  useEffect(() => {
    if (!waitingForDiscordJoin) return;

    const refreshSubmissionsPage = () => {
      setActive(null);
      setWaitingForDiscordJoin(false);
      setLocalVoteBlockedReason(undefined);
      setLocalVoteCooldownJoinedAt(undefined);
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
      return "You're banned from voting";
    }

    if (effectiveVoteBlockedReason === "not_in_discord") {
      return "Join Discord to vote";
    }

    if (effectiveVoteBlockedReason === "joined_too_recently") {
      return null;
    }

    return null;
  }

  const voteBlockedMessage = getVoteBlockedMessage();

  async function vote(submissionId: number) {
    if (!votingEnabled || votedSubmissionIdSet.has(submissionId)) {
      return;
    }

    if (effectiveVoteBlockedReason === "joined_too_recently") {
      return;
    }

    if (effectiveVoteBlockedReason) return;

    const fd = new FormData();
    fd.append("submissionId", String(submissionId));

    const res = await fetch("/api/vote", {
      method: "POST",
      body: fd,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);

      if (data?.error === "NOT_IN_DISCORD") {
        setLocalVoteBlockedReason("not_in_discord");
        return;
      }

      if (data?.error === "JOINED_TOO_RECENTLY") {
        const joinedAt =
          typeof data.joinedAt === "string" ? data.joinedAt : null;

        setLocalVoteBlockedReason("joined_too_recently");
        setLocalVoteCooldownJoinedAt(joinedAt);
        return;
      }

      return;
    }

    const data = await res.json().catch(() => null);
    const nextVoteCount =
      typeof data?.voteCount === "number"
        ? data.voteCount
        : usedVotes + 1;

    setUsedVotes(nextVoteCount);
    setVoted(
      typeof data?.hasVoted === "boolean"
        ? data.hasVoted
        : nextVoteCount >= votesPerUser
    );
    setLocalVotes((v) => ({
      ...v,
      [submissionId]: v[submissionId] + 1,
    }));
    setVotedSubmissionIdSet((current) => {
      const next = new Set(current);
      next.add(submissionId);
      return next;
    });
    setActive(null);
  }

  return (
    <>
      <div className="min-h-screen pt-20 px-6 pb-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 content-start">
        <div className="col-span-full pb-3 text-center font-['Permanent_Marker'] text-[var(--orange-main)]">
          {isPaused
            ? "CYCLE PAUSED"
            : votingEnabled
              ? `VOTING OPEN - ${usedVotes}/${votesPerUser} VOTES USED`
              : "SUBMISSIONS OPEN - VOTING STARTS LATER"}
        </div>
        {submissions.map((s) => {
          const url = new URL(s.image_url);
          const thumbSrc = `${url.origin}/cdn-cgi/image/w=400,q=75${url.pathname}`;

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
              <img
                src={thumbSrc}
                alt=""
                loading="lazy"
                decoding="async"
                fetchPriority="low"
                className="absolute inset-0 h-full w-full object-cover transition-transform group-hover:scale-105"
              />

              <div className="absolute bottom-0 w-full bg-black/60 text-white text-sm p-2">
                Votes: {localVotes[s.id]}
                {s.discord_user_id === discordUserId && (
                  <span className="ml-2 opacity-70">(you)</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 bg-black/90 overflow-y-auto overscroll-contain p-6"
          onClick={() => setActive(null)}
        >
          <button
            onClick={() => setActive(null)}
            className="fixed top-4 right-4 z-[60] text-white text-2xl bg-black/60 rounded-full w-10 h-10 flex items-center justify-center hover:bg-black/80"
          >
            x
          </button>

          <div
            className="relative mx-auto w-fit bg-black rounded-lg"
            onClick={(e) => e.stopPropagation()}
          >
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
                Votes: {localVotes[active.id]}
                {votingEnabled && votesPerUser > 1 ? (
                  <span className="ml-3 text-white/60">
                    Your votes: {usedVotes}/{votesPerUser}
                  </span>
                ) : null}
              </span>

              <div className="flex min-w-[90px] justify-center">
                {!votingEnabled ? (
                  <span className="text-center text-xs text-white/60">
                    {isPaused ? "Cycle paused" : "Voting not open yet"}
                  </span>
                ) : active.discord_user_id !== discordUserId &&
                effectiveVoteBlockedReason === "joined_too_recently" ? (
                  <div className="flex flex-col items-center leading-tight">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-white/55">
                      Please wait:
                    </span>
                    <DiscordCooldownTimer
                      joinedAt={effectiveVoteCooldownJoinedAt}
                      onComplete={() => {
                        setLocalVoteBlockedReason(null);
                        setLocalVoteCooldownJoinedAt(null);
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
                    effectiveVoteBlockedReason === "not_in_discord" ? (
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
                    <button
                      onClick={() => vote(active.id)}
                      disabled={
                        effectiveVoteBlockedReason === "joined_too_recently"
                      }
                      className={`rounded px-4 py-2 transition ${
                        effectiveVoteBlockedReason === "joined_too_recently"
                          ? "cursor-not-allowed bg-orange-500/35 text-white/45"
                          : "cursor-pointer bg-orange-500 hover:bg-orange-600"
                      }`}
                    >
                      Vote
                    </button>
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
