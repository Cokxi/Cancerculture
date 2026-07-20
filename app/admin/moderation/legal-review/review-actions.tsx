"use client";

import { useState } from "react";

type ReviewActionsProps = {
  submissionId: number;
  status: "legal_review" | "removed";
  visibilitySource: string;
  discordBanActive: boolean;
};

export default function ReviewActions({
  submissionId,
  status,
  visibilitySource,
  discordBanActive,
}: ReviewActionsProps) {
  const [reason, setReason] = useState("");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function updateStatus(nextStatus: "visible" | "removed") {
    const res = await fetch(
      "/api/admin/submissions/public-visibility",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          status: nextStatus,
          reasonCode:
            nextStatus === "visible"
              ? null
              : "manual_review",
          reasonText: null,
        }),
      }
    );

    if (!res.ok) {
      alert("Visibility update failed");
      return;
    }

    window.location.reload();
  }

  async function republishDiscordBanSubmission() {
    setSubmitting(true);

    try {
      const res = await fetch(
        "/api/admin/submissions/republish",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionId,
            reason,
            manualReviewConfirmed: reviewConfirmed,
          }),
        }
      );

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        alert(
          typeof body.error === "string"
            ? body.error
            : "Republish failed"
        );
        return;
      }

      window.location.reload();
    } finally {
      setSubmitting(false);
    }
  }

  if (
    status === "removed" &&
    visibilitySource === "discord_ban"
  ) {
    return (
      <div className="mt-4 space-y-3 rounded-lg border border-orange-400/30 bg-orange-500/5 p-3">
        {discordBanActive ? (
          <p className="text-xs text-orange-200">
            Republish stays locked while the Discord ban is active.
          </p>
        ) : null}
        <label className="block text-xs text-white/75">
          Mandatory review reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            className="mt-2 min-h-24 w-full rounded border border-white/15 bg-black/50 p-2 text-sm text-white"
          />
        </label>

        <label className="flex items-start gap-2 text-xs text-white/75">
          <input
            type="checkbox"
            checked={reviewConfirmed}
            onChange={(event) =>
              setReviewConfirmed(event.target.checked)
            }
            className="mt-0.5"
          />
          <span>
            I manually reviewed this Submission. Republishing changes public
            visibility only and does not restore competition eligibility.
          </span>
        </label>

        <button
          type="button"
          disabled={
            submitting ||
            discordBanActive ||
            !reviewConfirmed ||
            reason.trim().length < 10
          }
          onClick={republishDiscordBanSubmission}
          className="rounded-full border border-green-400/40 bg-green-500/10 px-3 py-2 text-xs text-green-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Republishing..." : "Republish after Review"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {status === "legal_review" ? (
        <button
          type="button"
          onClick={() => updateStatus("removed")}
          className="rounded-full border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          Remove from Public
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => updateStatus("visible")}
        className="rounded-full border border-green-400/40 bg-green-500/10 px-3 py-2 text-xs text-green-200"
      >
        Restore Public
      </button>
    </div>
  );
}
