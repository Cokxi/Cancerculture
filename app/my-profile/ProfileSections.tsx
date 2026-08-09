"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, type ReactNode } from "react";
import { SUBMISSION_PUBLIC_VISIBILITY } from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
import { getSubmissionThumbnailUrl } from "@/lib/r2/getSubmissionThumbnailUrl";
import type {
  ProfileSubmission,
  ProfileVote,
} from "@/lib/profile/getUserProfileData";

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border-2 border-[var(--orange-dark)]/60 bg-black/30">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left font-[var(--font-marker)] tracking-wide text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
      >
        {title}
        <span className="text-lg">{open ? "-" : "+"}</span>
      </button>

      {open && <div className="p-4">{children}</div>}
    </div>
  );
}

function renderRank(submission: ProfileSubmission) {
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

export default function ProfileSections({
  submissions,
  votes,
}: {
  submissions: ProfileSubmission[];
  votes: ProfileVote[];
}) {
  const [hidingSubmissionId, setHidingSubmissionId] =
    useState<number | null>(null);

  async function hideSubmissionFromProfile(
    submissionId: number
  ) {
    const confirmed = window.confirm(
      "Hide this disqualified submission from your profile? This does not delete moderation records."
    );

    if (!confirmed) {
      return;
    }

    setHidingSubmissionId(submissionId);

    try {
      const response = await fetch(
        `/api/profile/submissions/${submissionId}/hide`,
        {
          method: "POST",
        }
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error ??
            "Failed to hide submission from profile"
        );
      }

      window.location.reload();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Failed to hide submission from profile"
      );
      setHidingSubmissionId(null);
    }
  }

  return (
    <div className="space-y-4">
      <Section title="My Submissions">
        {submissions.length > 0 ? (
          <div className="space-y-4">
            {submissions.map((submission) => (
              <div
                key={submission.id}
                className="rounded-lg border-2 border-[var(--orange-dark)]/40 bg-black/40 p-4 text-white"
              >
                {(() => {
                  const destinationHref = submission.destination_href;

                  return (
                    <>
                {submission.image_url ? (
                  destinationHref ? (
                    <Link
                      href={destinationHref}
                      className="mb-2 block h-40 w-40 rounded focus:outline-none focus:ring-2 focus:ring-[var(--orange-dark)]"
                    >
                      <Image
                        src={getSubmissionThumbnailUrl(submission.image_url)}
                        className="h-40 w-40 rounded object-cover transition hover:opacity-85"
                        alt={`Submission for cycle ${submission.cycle_id}`}
                        width={160}
                        height={160}
                        unoptimized
                      />
                    </Link>
                  ) : (
                    <Image
                      src={getSubmissionThumbnailUrl(submission.image_url)}
                      className="mb-2 h-40 w-40 rounded object-cover"
                      alt={`Submission for cycle ${submission.cycle_id}`}
                      width={160}
                      height={160}
                      unoptimized
                    />
                  )
                  ) : (
                    <div className="mb-2 flex h-40 w-40 items-center justify-center rounded bg-orange-200/20 text-4xl">
                      {renderPublicVisibilityStatus(submission)
                        ? "-"
                        : "?"}
                    </div>
                  )}

                <p className="text-sm text-gray-300">
                  Cycle: {submission.cycle_id}
                </p>

                <p className="text-sm text-gray-300">
                  Votes: {submission.vote_count}
                </p>

                <p className="text-sm text-gray-300">
                  Rank:{" "}
                  <span className="font-[var(--font-marker)] text-[var(--orange-dark)]">
                    {renderRank(submission)}
                  </span>
                </p>

                {destinationHref ? (
                  <Link
                    href={destinationHref}
                    className="mt-2 inline-flex rounded-full border border-[var(--orange-dark)]/40 px-3 py-1 text-xs text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
                  >
                    {destinationHref.startsWith("/submissions")
                      ? "View in Current Submissions"
                      : "View in Cycle History"}
                  </Link>
                ) : null}
                    </>
                  );
                })()}

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
                          Explanation:{" "}
                          {submission.disqualification_reason_text}
                        </div>
                      )}
                    </div>
                  ) : renderPublicVisibilityStatus(
                      submission
                    ) ? (
                    <div className="text-yellow-300">
                      {renderPublicVisibilityStatus(submission)}

                      {submission.public_visibility_reason_code && (
                        <div className="mt-1 text-[11px] text-yellow-200">
                          {formatReason(
                            submission.public_visibility_reason_code
                          )}
                        </div>
                      )}

                      {submission.public_visibility_reason_text && (
                        <div className="mt-1 text-[11px] text-yellow-200">
                          {submission.public_visibility_reason_text}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-green-400">Active</div>
                  )}
                </div>

                {submission.can_hide_from_profile ? (
                  <button
                    type="button"
                    disabled={hidingSubmissionId === submission.id}
                    onClick={() =>
                      hideSubmissionFromProfile(submission.id)
                    }
                    className="mt-3 cursor-pointer rounded-full border border-yellow-400/30 bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-200 transition hover:bg-yellow-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {hidingSubmissionId === submission.id
                      ? "Hiding..."
                      : "Hide from my profile"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-400">
            No submissions yet.
          </div>
        )}
      </Section>

      <Section title="My Reports">
        <p className="text-sm text-gray-300">
          Review the reports submitted by your account and their
          privacy-safe status.
        </p>
        <Link
          href="/my-reports"
          className="mt-3 inline-flex cursor-pointer rounded-full border border-[var(--orange-dark)]/40 px-4 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
        >
          View all reports
        </Link>
      </Section>

      <Section title="My Moderation History">
        <p className="text-sm text-gray-300">
          Review your private history of recorded submission
          disqualifications and reinstatements.
        </p>
        <Link
          href="/my-profile/disqualifications"
          className="mt-3 inline-flex rounded-full border border-[var(--orange-dark)]/40 px-4 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
        >
          Open moderation history
        </Link>
      </Section>

      <Section title="My Votes">
        {votes.length > 0 ? (
          <div className="space-y-3">
            {votes.map((vote) => (
              <div
                key={`${vote.cycle_id}-${vote.submission_id}-${vote.created_at}`}
                className="rounded border border-[#222] bg-[#0b0b0b] p-3 text-sm"
              >
                <div>
                  <strong>Cycle #{vote.cycle_id}</strong>
                </div>

                {vote.image_url ? (
                  <Image
                    src={getSubmissionThumbnailUrl(vote.image_url)}
                    className="mt-2 h-24 w-24 rounded border border-[#222] object-cover"
                    alt={`Voted submission ${vote.submission_id}`}
                    width={96}
                    height={96}
                    unoptimized
                  />
                ) : (
                  <div className="mt-2 flex h-24 w-24 items-center justify-center rounded bg-orange-200/20 text-2xl">
                    ?
                  </div>
                )}

                <div className="mt-2 text-xs text-gray-500">
                  {vote.created_at
                    ? new Date(vote.created_at).toLocaleString()
                    : ""}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-400">
            No votes yet.
          </div>
        )}
      </Section>

    </div>
  );
}
