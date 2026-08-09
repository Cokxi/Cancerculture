"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DISPOSITIONS = [
  ["action_taken", "Action taken after review"],
  ["no_action_current_rules", "No action under current rules"],
  ["insufficient_information", "Insufficient information"],
  ["submission_unavailable", "Submission unavailable"],
  ["completed_other", "Completed - other"],
] as const;

export default function SubmissionReportReviewActions({
  caseId,
  latestReportId,
  rowVersion,
  status,
  unseen,
}: {
  caseId: string;
  latestReportId: string;
  rowVersion: number;
  status: "open" | "in_review" | "closed";
  unseen: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [disposition, setDisposition] = useState(DISPOSITIONS[0][0]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function mutate(operation: "acknowledge" | "start_review" | "return_open" | "close") {
    const destructiveLabel = operation === "close" ? "close this case" : operation.replaceAll("_", " ");
    if (!window.confirm(`Confirm ${destructiveLabel}?`)) return;
    setPending(true);
    setMessage(null);
    setStale(false);
    try {
      const response = await fetch("/api/admin/submission-reports/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caseId,
          operation,
          expectedStatus: status,
          expectedRowVersion: rowVersion,
          expectedLatestReportId: latestReportId,
          disposition: operation === "close" ? disposition : null,
          note: operation === "return_open" || operation === "close" ? note.trim() : null,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setStale(response.status === 409);
        setMessage(response.status === 409
          ? "This case changed. Refresh before making a decision."
          : data?.error ?? "Review action failed.");
        return;
      }
      setMessage("Review state saved.");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.04] p-5" aria-labelledby="report-review-actions">
      <h2 id="report-review-actions" className="text-xl font-semibold">Review actions</h2>
      <p className="mt-2 text-sm text-white/60">Seen state and workflow state are separate. All mutations use the exact case version and latest Report cursor.</p>

      {status === "in_review" ? (
        <>
          <label className="mt-5 block text-sm font-medium">
            Decision / return note
            <textarea
              rows={5}
              minLength={10}
              maxLength={1000}
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
              className="mt-2 w-full rounded-lg border border-white/20 bg-black/50 p-3"
              placeholder="Required for returning or closing the case (10-1000 characters)."
            />
          </label>
          <label className="mt-4 block text-sm font-medium">
            Close disposition
            <select value={disposition} onChange={(event) => setDisposition(event.target.value as typeof disposition)} className="mt-2 w-full rounded-lg border border-white/20 bg-black/70 p-3">
              {DISPOSITIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3">
        {unseen && status !== "closed" ? <button disabled={pending} onClick={() => void mutate("acknowledge")} className="cursor-pointer rounded-full border border-orange-300/50 px-4 py-2 text-sm text-orange-100 disabled:cursor-not-allowed disabled:opacity-40">Mark reports seen</button> : null}
        {status === "open" ? <button disabled={pending} onClick={() => void mutate("start_review")} className="cursor-pointer rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">Start review</button> : null}
        {status === "in_review" ? (
          <>
            <button disabled={pending || note.trim().length < 10} onClick={() => void mutate("return_open")} className="cursor-pointer rounded-full border border-white/25 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40">Return to queue</button>
            <button disabled={pending || note.trim().length < 10} onClick={() => void mutate("close")} className="cursor-pointer rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">Close case</button>
          </>
        ) : null}
      </div>
      {message ? <p role="status" className="mt-4 text-sm text-white/80">{message}</p> : null}
      {stale ? <button type="button" onClick={() => router.refresh()} className="mt-3 cursor-pointer text-sm text-orange-300 underline">Refresh case</button> : null}
    </section>
  );
}
