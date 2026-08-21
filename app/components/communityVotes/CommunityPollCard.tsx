"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CommunityPoll } from "@/lib/communityPolls/types";

type ViewerStatus =
  | "authenticated"
  | "anonymous"
  | "restricted"
  | "dependency_unavailable";

function formatDate(value?: string) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatRemaining(milliseconds: number) {
  if (milliseconds <= 0) return "Voting ended";
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function outcomeLabel(poll: CommunityPoll) {
  switch (poll.outcome) {
    case "winner":
      return "Decision recorded";
    case "runoff":
      return "Runoff required";
    case "no_result":
      return "Closed without a result — no votes were cast";
    case "aborted":
      return "Poll aborted";
    case "replaced":
      return "Poll replaced";
    default:
      return poll.status === "active" ? "Voting open" : "Draft";
  }
}

export default function CommunityPollCard({
  initialPoll,
  initialServerNow,
  viewerStatus,
  loginPath,
  showStableLink = true,
}: {
  initialPoll: CommunityPoll;
  initialServerNow: string;
  viewerStatus: ViewerStatus;
  loginPath: string;
  showStableLink?: boolean;
}) {
  const [poll, setPoll] = useState(initialPoll);
  const [selectedOption, setSelectedOption] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [serverOffset] = useState(
    () => new Date(initialServerNow).getTime() - Date.now()
  );
  const deadline = poll.deadlineAt
    ? new Date(poll.deadlineAt).getTime()
    : null;
  const remaining = deadline === null ? 0 : deadline - (now + serverOffset);
  const votingOpen = poll.votingOpen && remaining > 0;

  useEffect(() => {
    if (poll.status !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [poll.status]);

  const refresh = useCallback(async () => {
    if (!poll.resultsVisible || poll.status !== "active") return;
    setBusy(true);
    try {
      const response = await fetch(`/api/community-votes/${poll.publicId}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const body = (await response.json()) as { poll?: CommunityPoll };
      if (response.ok && body.poll) {
        setPoll(body.poll);
        setNotice("Results refreshed.");
      } else {
        setNotice("Results could not be refreshed right now.");
      }
    } catch {
      setNotice("Results could not be refreshed right now.");
    } finally {
      setBusy(false);
    }
  }, [poll.publicId, poll.resultsVisible, poll.status]);

  useEffect(() => {
    if (!poll.resultsVisible || poll.status !== "active") return;
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [poll.resultsVisible, poll.status, refresh]);

  const winnerLabel = useMemo(
    () =>
      poll.options.find(
        (option) => option.publicId === poll.winningOptionPublicId
      )?.label,
    [poll.options, poll.winningOptionPublicId]
  );

  async function submitVote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedOption || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`/api/community-votes/${poll.publicId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionPublicId: selectedOption,
          requestId: crypto.randomUUID(),
          expectedPollVersion: poll.rowVersion,
        }),
      });
      const body = (await response.json()) as {
        outcome?: string;
        poll?: CommunityPoll;
        selectedOption?: { label?: string };
        error?: string;
      };
      if (body.poll) setPoll(body.poll);
      if (response.ok && body.outcome === "voted") {
        setNotice(
          `Your irrevocable vote for “${body.selectedOption?.label ?? "the selected option"}” was recorded.`
        );
      } else if (response.ok && body.outcome === "already_participated") {
        setNotice("You already voted in this poll. Your aggregate results are shown.");
      } else if (response.status === 409) {
        setNotice("The poll changed or voting has ended. Refresh and review the current state.");
      } else {
        setNotice(body.error ?? "Your vote could not be recorded.");
      }
    } catch {
      setNotice("Your vote could not be recorded. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="overflow-hidden rounded-2xl border border-orange-500/30 bg-black/55 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
      <div className="space-y-4 p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs uppercase tracking-[0.18em] text-white/55">
          <span>{outcomeLabel(poll)}</span>
          {poll.deadlineAt ? (
            <span aria-live="off">Ends {formatDate(poll.deadlineAt)}</span>
          ) : null}
        </div>

        <div>
          <h2 className="font-permanent-marker text-2xl leading-tight text-[var(--orange-main)] sm:text-3xl">
            {poll.question}
          </h2>
          {poll.context ? (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/75 sm:text-base">
              {poll.context}
            </p>
          ) : null}
        </div>

        {poll.status === "active" ? (
          <p className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/75">
            <span className="font-semibold text-white">Time remaining:</span>{" "}
            <span aria-live="off">{formatRemaining(remaining)}</span>
          </p>
        ) : null}

        {poll.resultsVisible ? (
          <section aria-label="Poll results" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/65">
              <span>
                {poll.totalVotes ?? 0} total {poll.totalVotes === 1 ? "vote" : "votes"}
              </span>
              <span>Updated {formatDate(poll.lastUpdatedAt)}</span>
            </div>
            <ol className="space-y-3">
              {poll.options.map((option) => (
                <li key={option.publicId} className="space-y-1.5">
                  <div className="flex items-start justify-between gap-4 text-sm">
                    <span className="min-w-0 break-words font-medium text-white">
                      {option.label}
                      {poll.winningOptionPublicId === option.publicId ? (
                        <span className="ml-2 rounded bg-orange-500/20 px-2 py-0.5 text-xs text-orange-200">
                          Winner
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-white/70">
                      {option.voteCount ?? 0} · {(option.percentage ?? 0).toFixed(1)}%
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-white/10"
                    role="img"
                    aria-label={`${option.label}: ${option.voteCount ?? 0} votes, ${(option.percentage ?? 0).toFixed(1)} percent`}
                  >
                    <div
                      className="h-full rounded-full bg-[var(--orange-main)] transition-[width]"
                      style={{ width: `${Math.max(0, Math.min(100, option.percentage ?? 0))}%` }}
                    />
                  </div>
                </li>
              ))}
            </ol>
            {winnerLabel ? (
              <p className="text-sm font-semibold text-orange-200">
                Recorded decision: {winnerLabel}
              </p>
            ) : null}
            {poll.status === "active" ? (
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={busy}
                className="min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:border-orange-400 hover:text-orange-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-wait disabled:opacity-50"
              >
                Refresh results
              </button>
            ) : null}
          </section>
        ) : poll.status === "active" && votingOpen ? (
          viewerStatus === "authenticated" ? (
            <form onSubmit={submitVote} className="space-y-4">
              <fieldset disabled={busy} className="space-y-3">
                <legend className="mb-2 text-sm font-semibold text-white">
                  Choose once — your vote cannot be changed or withdrawn
                </legend>
                {poll.options.map((option) => (
                  <label
                    key={option.publicId}
                    className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-sm text-white transition hover:border-orange-400/70 has-[:checked]:border-orange-400 has-[:checked]:bg-orange-500/10"
                  >
                    <input
                      type="radio"
                      name={`poll-${poll.publicId}`}
                      value={option.publicId}
                      checked={selectedOption === option.publicId}
                      onChange={() => setSelectedOption(option.publicId)}
                      className="mt-0.5 size-4 shrink-0 accent-orange-500"
                      required
                    />
                    <span className="min-w-0 break-words">{option.label}</span>
                  </label>
                ))}
              </fieldset>
              <button
                type="submit"
                disabled={busy || !selectedOption}
                className="min-h-11 rounded-lg bg-[var(--orange-main)] px-5 py-2 font-bold text-black transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busy ? "Recording…" : "Submit irrevocable vote"}
              </button>
              <p className="text-xs leading-5 text-white/55">
                CancerCulture stores a poll-specific participation proof separately from option totals. No voter-to-option list exists.
              </p>
            </form>
          ) : viewerStatus === "anonymous" ? (
            <div className="rounded-xl border border-orange-500/25 bg-orange-500/10 p-4">
              <p className="text-sm leading-6 text-white/75">
                Sign in with your CancerCulture account to vote. Discord server membership is not required.
              </p>
              <a
                href={`/api/auth/discord/login?state=${encodeURIComponent(loginPath)}`}
                className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-[var(--orange-main)] px-4 py-2 font-bold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
              >
                Sign in to vote
              </a>
            </div>
          ) : viewerStatus === "restricted" ? (
            <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
              This account cannot vote. Poll content remains readable.
            </p>
          ) : (
            <p className="rounded-xl border border-white/15 bg-white/[0.04] p-4 text-sm text-white/65">
              Voting eligibility is temporarily unavailable. Please try again later.
            </p>
          )
        ) : (
          <p className="rounded-xl border border-white/15 bg-white/[0.04] p-4 text-sm text-white/65">
            Voting has ended. The final aggregate will appear after the poll is closed.
          </p>
        )}

        {notice ? (
          <p aria-live="polite" className="text-sm font-medium text-orange-200">
            {notice}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3 border-t border-white/10 pt-4 text-sm">
          {showStableLink ? (
            <Link
              href={`/community-votes/${poll.publicId}`}
              className="font-semibold text-orange-300 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
            >
              Open stable poll page
            </Link>
          ) : null}
          {poll.parentPollPublicId ? (
            <Link className="text-white/65 hover:text-white" href={`/community-votes/${poll.parentPollPublicId}`}>
              View previous round
            </Link>
          ) : null}
          {poll.replacementPollPublicId ? (
            <Link className="text-white/65 hover:text-white" href={`/community-votes/${poll.replacementPollPublicId}`}>
              View replacement poll
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
