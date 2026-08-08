"use client";

import type {
  VoteRefundCandidate,
  VoteRefundCycle,
} from "@/lib/voteRefund/readModel.server";
import Image from "next/image";
import { useMemo, useRef, useState } from "react";

export default function VoteRefundPanel({
  cycle,
  candidates,
}: {
  cycle: VoteRefundCycle;
  candidates: readonly VoteRefundCandidate[];
}) {
  const [selectedIds, setSelectedIds] = useState<readonly number[]>([]);
  const [reasonText, setReasonText] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const selected = useMemo(
    () =>
      candidates.filter((candidate) =>
        selectedIds.includes(candidate.submissionId)
      ),
    [candidates, selectedIds]
  );
  const selectedVoteCount = selected.reduce(
    (total, candidate) => total + candidate.refundableVoteCount,
    0
  );
  const requiredConfirmation = `REFUND ${selectedVoteCount}`;

  function toggleSubmission(submissionId: number) {
    setSelectedIds((current) =>
      current.includes(submissionId)
        ? current.filter((id) => id !== submissionId)
        : [...current, submissionId]
    );
    setConfirming(false);
    setConfirmationText("");
    idempotencyKeyRef.current = null;
  }

  async function submitRefund() {
    if (
      pending ||
      selected.length === 0 ||
      reasonText.trim().length < 3 ||
      confirmationText !== requiredConfirmation
    ) {
      return;
    }

    setPending(true);
    idempotencyKeyRef.current ??= crypto.randomUUID();

    try {
      const response = await fetch("/api/admin/vote-refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycleId: cycle.id,
          expectedResetCount: cycle.resetCount,
          expectedVotesPerUser: cycle.votesPerUser,
          selections: selected.map((candidate) => ({
            submissionId: candidate.submissionId,
            expectedDisqualifiedAt: candidate.disqualifiedAt,
            expectedVoteCount: candidate.refundableVoteCount,
          })),
          reasonText: reasonText.trim(),
          idempotencyKey: idempotencyKeyRef.current,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const code =
          typeof payload?.error === "string"
            ? payload.error
            : "VOTE_REFUND_FAILED";
        if (response.status === 409) {
          idempotencyKeyRef.current = null;
          window.alert(
            "The refund state changed. The page will now be refreshed without refunding a partial selection."
          );
          window.location.reload();
          return;
        }
        window.alert(code);
        return;
      }

      if (
        payload?.success !== true ||
        !Number.isSafeInteger(payload?.result?.refundedVoteCount)
      ) {
        window.alert("Vote refund returned an invalid response.");
        return;
      }

      idempotencyKeyRef.current = null;
      window.alert(
        `${payload.result.refundedVoteCount} vote${payload.result.refundedVoteCount === 1 ? "" : "s"} refunded successfully.`
      );
      window.location.reload();
    } catch {
      window.alert(
        "The refund request could not be confirmed. Check your connection and retry; the same request ID will be reused safely."
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4">
        <div>
          <p className="text-sm font-medium">
            {selected.length} selected · {selectedVoteCount} refundable vote
            {selectedVoteCount === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs text-white/45">
            Only checked submissions are affected. Every other disqualified
            submission keeps all of its votes.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
            onClick={() => {
              setSelectedIds(candidates.map((candidate) => candidate.submissionId));
              setConfirming(false);
              setConfirmationText("");
              idempotencyKeyRef.current = null;
            }}
          >
            Select all on this page
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/5"
            onClick={() => {
              setSelectedIds([]);
              setConfirming(false);
              setConfirmationText("");
              idempotencyKeyRef.current = null;
            }}
          >
            Deselect all
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {candidates.map((candidate) => {
          const checked = selectedIds.includes(candidate.submissionId);
          return (
            <label
              key={candidate.submissionId}
              className={`cursor-pointer rounded-xl border p-4 transition ${
                checked
                  ? "border-orange-300/70 bg-orange-400/10"
                  : "border-white/10 bg-white/[0.025] hover:border-white/20"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleSubmission(candidate.submissionId)}
                  className="mt-1 h-4 w-4 accent-orange-400"
                />
                <div className="min-w-0 flex-1">
                  {candidate.thumbnailUrl ? (
                    <Image
                      src={candidate.thumbnailUrl}
                      alt=""
                      width={400}
                      height={160}
                      unoptimized
                      className="mb-3 h-32 w-full rounded-lg object-cover"
                    />
                  ) : (
                    <div className="mb-3 flex h-32 items-center justify-center rounded-lg border border-white/10 text-xs text-white/40">
                      Preview unavailable
                    </div>
                  )}
                  <p className="font-semibold">
                    Submission #{candidate.submissionId}
                  </p>
                  <p className="mt-1 text-sm text-orange-200">
                    {candidate.refundableVoteCount} refundable vote
                    {candidate.refundableVoteCount === 1 ? "" : "s"}
                  </p>
                  <p className="mt-2 text-xs text-white/45">
                    DQ category: {candidate.disqualificationType ?? "unspecified"}
                  </p>
                  <p className="mt-1 text-xs text-white/35">
                    DQ at {new Date(candidate.disqualifiedAt).toLocaleString()}
                  </p>
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div className="mt-6 rounded-xl border border-red-300/20 bg-red-500/[0.06] p-4">
        <label className="block text-sm font-medium" htmlFor="refund-reason">
          Required audit reason
        </label>
        <textarea
          id="refund-reason"
          value={reasonText}
          maxLength={1000}
          rows={3}
          onChange={(event) => {
            setReasonText(event.target.value);
            idempotencyKeyRef.current = null;
          }}
          className="mt-2 w-full rounded-lg border border-white/15 bg-black/30 p-3 text-sm outline-none focus:border-orange-300"
          placeholder="Why are these votes safe to return now?"
        />
        <button
          type="button"
          disabled={selected.length === 0 || reasonText.trim().length < 3}
          onClick={() => {
            setConfirming(true);
            setConfirmationText("");
          }}
          className="mt-3 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Review selected refund
        </button>
      </div>

      {confirming ? (
        <section
          aria-labelledby="refund-confirmation-title"
          className="mt-5 rounded-xl border border-red-300/35 bg-black/40 p-5"
        >
          <h2 id="refund-confirmation-title" className="text-lg font-semibold">
            Confirm irreversible vote refund
          </h2>
          <p className="mt-2 text-sm text-white/65">
            This removes {selectedVoteCount} canonical vote
            {selectedVoteCount === 1 ? "" : "s"} from {selected.length}{" "}
            explicitly selected submission{selected.length === 1 ? "" : "s"}
            in Cycle #{cycle.id}. A later reinstatement will not restore these
            votes.
          </p>
          <label className="mt-4 block text-sm" htmlFor="refund-confirmation">
            Type <strong>{requiredConfirmation}</strong> to confirm
          </label>
          <input
            id="refund-confirmation"
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
            className="mt-2 w-full max-w-sm rounded-lg border border-white/15 bg-black/30 px-3 py-2 outline-none focus:border-red-300"
            autoComplete="off"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={pending || confirmationText !== requiredConfirmation}
              onClick={submitRefund}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Refunding…" : "Refund selected votes"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setConfirmationText("");
              }}
              className="rounded-lg border border-white/15 px-4 py-2 text-sm disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
