"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { SUBMISSION_PUBLIC_VISIBILITY } from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import type {
  ProfileSubmission,
  ProfileVote,
} from "@/lib/profile/getUserProfileData";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import type { ProfileWinSummary } from "@/lib/profile/profileWinSummary";
import type { OwnWinnerClaimSummary } from "@/lib/winnerClaims/service.server";

function winnerStatusLabel(status: OwnWinnerClaimSummary["status"]) {
  if (status === "not_required") return "Donation — no claim required";
  if (status === "correction_pending") return "Wallet correction pending";
  if (status === "confirmed") return "Claimed";
  if (status === "declined") return "Declined";
  if (status === "expired") return "Not claimed within 24 hours";
  return "Unclaimed";
}

function renderRank(submission: ProfileSubmission) {
  if (!submission.rank) return "-";
  return `${submission.rank} / ${submission.total}${
    submission.tie_count > 1 ? ` (${submission.tie_count} tied)` : ""
  }`;
}

function renderPublicVisibilityStatus(submission: ProfileSubmission) {
  if (
    submission.public_visibility_status ===
    SUBMISSION_PUBLIC_VISIBILITY.legalReview
  ) return "Hidden pending legal review";
  if (
    submission.public_visibility_status ===
    SUBMISSION_PUBLIC_VISIBILITY.removed
  ) return "Removed from public view";
  return null;
}

export function ProfileSubmissionList({ submissions }: { submissions: ProfileSubmission[] }) {
  const [hidingSubmissionId, setHidingSubmissionId] = useState<number | null>(null);

  async function hideSubmissionFromProfile(submissionId: number) {
    const confirmed = window.confirm(
      "Hide this disqualified submission from your profile? This does not delete moderation records.",
    );
    if (!confirmed) return;
    setHidingSubmissionId(submissionId);
    try {
      const response = await fetch(`/api/profile/submissions/${submissionId}/hide`, {
        method: "POST",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Failed to hide submission from profile");
      }
      window.location.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to hide submission from profile");
      setHidingSubmissionId(null);
    }
  }

  if (submissions.length === 0) {
    return <p className="text-sm text-gray-400">No submissions yet.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {submissions.map((submission) => {
        const destinationHref = submission.destination_href;
        const visibilityStatus = renderPublicVisibilityStatus(submission);
        return (
          <article key={submission.id} className="rounded-lg border-2 border-[var(--orange-dark)]/40 bg-black/40 p-4 text-white">
            {submission.image_url ? (
              destinationHref ? (
                <Link href={destinationHref} className="mb-2 block h-40 w-40 rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">
                  <Image src={getSubmissionThumbnailUrl(submission.image_url)} className="h-40 w-40 rounded object-cover transition hover:opacity-85" alt={`Submission for cycle ${submission.cycle_number}`} width={160} height={160} unoptimized />
                </Link>
              ) : (
                <Image src={getSubmissionThumbnailUrl(submission.image_url)} className="mb-2 h-40 w-40 rounded object-cover" alt={`Submission for cycle ${submission.cycle_number}`} width={160} height={160} unoptimized />
              )
            ) : (
              <div className="mb-2 flex h-40 w-40 items-center justify-center rounded bg-orange-200/20 text-4xl">{visibilityStatus ? "-" : "?"}</div>
            )}
            <p className="text-sm text-gray-300">Cycle: {submission.cycle_number}</p>
            <p className="text-sm text-gray-300">Votes: {submission.vote_count}</p>
            <p className="text-sm text-gray-300">Rank: <span className="font-['Permanent_Marker'] text-[var(--orange-dark)]">{renderRank(submission)}</span></p>
            {destinationHref ? (
              <Link href={destinationHref} className="mt-2 inline-flex rounded-full border border-[var(--orange-dark)]/40 px-3 py-1 text-xs text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10">
                {destinationHref.startsWith("/submissions") ? "View in Current Submissions" : "View in Cycle History"}
              </Link>
            ) : null}
            <div className="mt-2 text-xs">
              {submission.is_disqualified ? (
                <div className="text-red-400">
                  Disqualified
                  {(submission.disqualification_reason_code || submission.disqualification_reason_category) ? (
                    <div className="mt-1 text-[11px] text-red-300">{formatReason(submission.disqualification_reason_code ?? submission.disqualification_reason_category!)}</div>
                  ) : null}
                  {submission.disqualification_reason_text ? <div className="mt-1 text-[11px] text-red-300">Explanation: {submission.disqualification_reason_text}</div> : null}
                </div>
              ) : visibilityStatus ? (
                <div className="text-yellow-300">
                  {visibilityStatus}
                  {submission.public_visibility_reason_code ? <div className="mt-1 text-[11px] text-yellow-200">{formatReason(submission.public_visibility_reason_code)}</div> : null}
                  {submission.public_visibility_reason_text ? <div className="mt-1 text-[11px] text-yellow-200">{submission.public_visibility_reason_text}</div> : null}
                </div>
              ) : <div className="text-green-400">Active</div>}
            </div>
            {submission.can_hide_from_profile ? (
              <button type="button" disabled={hidingSubmissionId === submission.id} onClick={() => void hideSubmissionFromProfile(submission.id)} className="mt-3 cursor-pointer rounded-full border border-yellow-400/30 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-200 transition hover:bg-yellow-500/20 disabled:cursor-not-allowed disabled:opacity-60">
                {hidingSubmissionId === submission.id ? "Hiding..." : "Hide from my profile"}
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function ProfileWinsList({ winnings }: { winnings: ProfileWinSummary[] | null }) {
  if (winnings === null) return <p className="text-sm text-gray-400">Winner Claims are temporarily unavailable.</p>;
  if (winnings.length === 0) return <p className="text-sm text-gray-400">No completed or pending-correction wins yet.</p>;
  return (
    <div className="space-y-3">
      {winnings.map((claim) => (
        <article key={claim.claimId} className="rounded-lg border border-[var(--orange-dark)]/40 bg-black/40 p-4 text-white">
          {claim.imageUrl ? (
            claim.destinationHref ? (
              <Link href={claim.destinationHref} className="mb-3 block h-40 w-40 rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">
                <Image src={getSubmissionThumbnailUrl(claim.imageUrl)} className="h-40 w-40 rounded object-cover transition hover:opacity-85" alt={`Winning submission for cycle ${claim.cycleNumber ?? claim.cycleId}`} width={160} height={160} unoptimized />
              </Link>
            ) : (
              <Image src={getSubmissionThumbnailUrl(claim.imageUrl)} className="mb-3 h-40 w-40 rounded object-cover" alt={`Winning submission for cycle ${claim.cycleNumber ?? claim.cycleId}`} width={160} height={160} unoptimized />
            )
          ) : (
            <div className="mb-3 flex h-40 w-40 items-center justify-center rounded bg-orange-200/20 text-4xl">?</div>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold">Cycle #{claim.cycleNumber ?? claim.cycleId} · Submission #{claim.submissionId}</p>
              <p className="mt-1 text-sm text-gray-300">
                {claim.payoutChoice === "keep" ? "Keep 100%" : claim.payoutChoice === "donate" ? `Donate 100%${claim.charity ? ` to ${claim.charity}` : ""}` : `Keep ${claim.splitPercent}% / donate ${100 - (claim.splitPercent ?? 0)}%${claim.charity ? ` to ${claim.charity}` : ""}`}
              </p>
            </div>
            <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/75">{winnerStatusLabel(claim.status)}</span>
          </div>
          {claim.destinationHref ? (
            <Link href={claim.destinationHref} className="mt-4 mr-3 inline-flex min-h-11 items-center rounded-lg border border-[var(--orange-dark)]/40 px-4 py-2 text-sm text-[var(--orange-dark)] outline-none transition hover:bg-[var(--orange-dark)]/10 focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">View in Cycle History</Link>
          ) : null}
          {claim.status !== "not_required" ? (
            <Link href={`/my-profile/winnings/${claim.claimId}`} className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-[var(--orange-dark)]/40 px-4 py-2 text-sm text-[var(--orange-dark)] outline-none transition hover:bg-[var(--orange-dark)]/10 focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">View Claim</Link>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function ProfileVotesList({ votes }: { votes: ProfileVote[] }) {
  if (votes.length === 0) return <p className="text-sm text-gray-400">No votes yet.</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {votes.map((vote) => (
        <article key={`${vote.cycle_id}-${vote.submission_id}-${vote.created_at}`} className="rounded border border-[#222] bg-[#0b0b0b] p-3 text-sm">
          <strong>Cycle #{vote.cycle_number}</strong>
          {vote.image_url ? (
            vote.destination_href ? (
              <Link href={vote.destination_href} className="mt-2 block h-24 w-24 rounded outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">
                <Image src={getSubmissionThumbnailUrl(vote.image_url)} className="h-24 w-24 rounded border border-[#222] object-cover transition hover:opacity-85" alt={`Voted submission ${vote.submission_id}`} width={96} height={96} unoptimized />
              </Link>
            ) : (
              <Image src={getSubmissionThumbnailUrl(vote.image_url)} className="mt-2 h-24 w-24 rounded border border-[#222] object-cover" alt={`Voted submission ${vote.submission_id}`} width={96} height={96} unoptimized />
            )
          ) : <div className="mt-2 flex h-24 w-24 items-center justify-center rounded bg-orange-200/20 text-2xl">?</div>}
          {vote.destination_href ? (
            <Link href={vote.destination_href} className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-[var(--orange-dark)]/40 px-3 py-2 text-xs text-[var(--orange-dark)] outline-none transition hover:bg-[var(--orange-dark)]/10 focus-visible:ring-2 focus-visible:ring-[var(--orange-dark)]">
              {vote.destination_href.startsWith("/submissions") ? "View in Current Submissions" : "View in Cycle History"}
            </Link>
          ) : null}
          <div className="mt-2 text-xs text-gray-500">{vote.created_at ? new Date(vote.created_at).toLocaleString() : ""}</div>
        </article>
      ))}
    </div>
  );
}
