"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { reviewUserFlagCase } from "@/app/admin/actions/reviewUserFlagCase";

const decisionButtonBase =
  "inline-flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-center text-sm font-semibold shadow-sm outline-none transition-[background-color,border-color,box-shadow,opacity,transform] focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none disabled:active:translate-y-0 sm:w-auto sm:min-w-40";

const resolveButtonClassName = `${decisionButtonBase} border-emerald-300/55 bg-emerald-500/20 text-emerald-50 hover:border-emerald-200 hover:bg-emerald-500/30`;
const dismissButtonClassName = `${decisionButtonBase} border-white/25 bg-white/10 text-white hover:border-white/40 hover:bg-white/15`;
const escalateButtonClassName = `${decisionButtonBase} border-amber-300/60 bg-amber-500/15 text-amber-50 hover:border-amber-200 hover:bg-amber-500/25`;
const banButtonClassName = `${decisionButtonBase} border-2 border-red-400/75 bg-red-500/20 text-red-50 hover:border-red-300 hover:bg-red-500/30`;

export default function FlagCaseReviewActions({
  caseId,
  rowVersion,
  status,
  isAdmin,
  canCreateWebsiteBan,
}: {
  caseId: string;
  rowVersion: number;
  status: "open" | "escalated";
  isAdmin: boolean;
  canCreateWebsiteBan: boolean;
}) {
  const router = useRouter();
  const [reviewReason, setReviewReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function submit(
    action: "resolved" | "dismissed" | "escalated" | "banned_resolved"
  ) {
    if (
      !window.confirm(
        action === "banned_resolved"
          ? "Confirm the atomic website ban and case resolution?"
          : `Confirm that this case should be marked ${action}?`
      )
    ) {
      return;
    }

    setPending(true);
    setMessage(null);
    setStale(false);

    try {
      const result = await reviewUserFlagCase({
        caseId,
        expectedRowVersion: rowVersion,
        status: action,
        reviewReason,
        idempotencyKey: crypto.randomUUID(),
      });

      if (!result.success) {
        setMessage(result.message);
        setStale(true);
        return;
      }

      setMessage(`Case marked ${result.status}.`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-flag-review-actions
      className="mt-5 max-w-3xl rounded-xl border border-white/15 bg-white/[0.035] p-4 shadow-[0_12px_34px_rgba(0,0,0,0.2)] sm:p-5"
      aria-labelledby="flag-review-heading"
    >
      <h2 id="flag-review-heading" className="text-xl font-semibold text-white">
        Review decision
      </h2>
      <p className="mt-1 text-sm leading-6 text-white/55">
        Add the required reason, then choose one outcome. Every action asks for
        confirmation before it is saved.
      </p>

      <label
        htmlFor="flag-review-reason"
        className="mt-5 block text-sm font-semibold text-white/90"
      >
        Required decision reason <span aria-hidden="true">*</span>
      </label>
      <textarea
        id="flag-review-reason"
        name="reviewReason"
        value={reviewReason}
        rows={5}
        minLength={3}
        maxLength={1000}
        required
        disabled={pending}
        aria-describedby="flag-review-reason-help flag-review-reason-count"
        onChange={(event) => setReviewReason(event.target.value)}
        placeholder="Explain why this outcome is appropriate."
        className="mt-2 min-h-32 w-full resize-y rounded-lg border-2 border-white/25 bg-black/45 px-3 py-3 text-base leading-6 text-white shadow-inner outline-none transition-[background-color,border-color,box-shadow,opacity] placeholder:text-white/35 hover:border-white/40 focus:border-orange-300 focus-visible:ring-2 focus-visible:ring-orange-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-white/40 disabled:opacity-70"
      />
      <div className="mt-1.5 flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-xs text-white/45">
        <span id="flag-review-reason-help">
          At least 3 characters. This reason becomes part of the case history.
        </span>
        <span id="flag-review-reason-count" aria-live="polite">
          {reviewReason.length}/1000
        </span>
      </div>

      <div
        role="group"
        aria-label="Flag case review actions"
        className="mt-5 flex flex-wrap gap-3 border-t border-white/10 pt-4"
      >
        <button
          type="button"
          data-review-action="resolved"
          className={resolveButtonClassName}
          disabled={pending || reviewReason.trim().length < 3}
          onClick={() => submit("resolved")}
        >
          {pending ? (
            "Saving..."
          ) : (
            <>
              <span aria-hidden="true">✓</span>
              <span>Resolve case</span>
            </>
          )}
        </button>
        <button
          type="button"
          data-review-action="dismissed"
          className={dismissButtonClassName}
          disabled={pending || reviewReason.trim().length < 3}
          onClick={() => submit("dismissed")}
        >
          {pending ? (
            "Saving..."
          ) : (
            <>
              <span aria-hidden="true">—</span>
              <span>Dismiss case</span>
            </>
          )}
        </button>
        {status === "open" ? (
          <button
            type="button"
            data-review-action="escalated"
            className={escalateButtonClassName}
            disabled={pending || reviewReason.trim().length < 3}
            onClick={() => submit("escalated")}
          >
            {pending ? (
              "Saving..."
            ) : (
              <>
                <span aria-hidden="true">↑</span>
                <span>Escalate case</span>
              </>
            )}
          </button>
        ) : null}
        {isAdmin && canCreateWebsiteBan && status === "escalated" ? (
          <button
            type="button"
            data-review-action="banned_resolved"
            className={banButtonClassName}
            disabled={pending || reviewReason.trim().length < 3}
            onClick={() => submit("banned_resolved")}
          >
            {pending ? (
              "Saving..."
            ) : (
              <>
                <span aria-hidden="true">!</span>
                <span>Ban user &amp; resolve</span>
              </>
            )}
          </button>
        ) : null}
      </div>
      {message ? (
        <p
          role="status"
          className="mt-4 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white/80"
        >
          {message}
        </p>
      ) : null}
      {stale ? (
        <button
          type="button"
          className="mt-3 inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-orange-300/55 bg-orange-500/15 px-4 py-2 text-sm font-semibold text-orange-50 outline-none transition-colors hover:bg-orange-500/25 focus-visible:ring-2 focus-visible:ring-orange-300 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          onClick={() => router.refresh()}
        >
          Refresh case
        </button>
      ) : null}
    </section>
  );
}
