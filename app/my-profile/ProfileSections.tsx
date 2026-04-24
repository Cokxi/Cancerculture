"use client";

import { useState, type ReactNode } from "react";
import { SUBMISSION_PUBLIC_VISIBILITY } from "@/lib/moderation/submissionPublicVisibility";
import { formatReason } from "@/lib/profile/formatReason";
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
                {submission.image_url ? (
                  <img
                    src={submission.image_url}
                    className="mb-2 h-40 w-40 rounded object-cover"
                    alt={`Submission for cycle ${submission.cycle_id}`}
                  />
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

                <div className="mt-2 text-xs">
                  {submission.is_disqualified ? (
                    <div className="text-red-400">
                      Disqualified

                      {submission.disqualification_reason_code && (
                        <div className="mt-1 text-[11px] text-red-300">
                          {formatReason(
                            submission.disqualification_reason_code
                          )}
                        </div>
                      )}

                      {submission.disqualification_reason_text && (
                        <div className="mt-1 text-[11px] text-red-300">
                          {submission.disqualification_reason_text}
                        </div>
                      )}

                      {submission.disqualified_by_discord_username && (
                        <div className="text-[11px] text-red-300">
                          by{" "}
                          {
                            submission.disqualified_by_discord_username
                          }
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
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-400">
            No submissions yet.
          </div>
        )}
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
                  <img
                    src={vote.image_url}
                    className="mt-2 h-24 w-24 rounded border border-[#222] object-cover"
                    alt={`Voted submission ${vote.submission_id}`}
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

      <Section title="My Comments">
        <p className="text-sm text-gray-400">
          Coming soon...
        </p>
      </Section>
    </div>
  );
}
