"use client";

import { useState } from "react";

export default function ReinstateButton({
  submissionId,
  cycleId,
  phase,
}: {
  submissionId: number;
  cycleId: number;
  phase: "submission_open" | "voting_open";
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReinstate() {
    const reason = prompt("Reason for reinstating this submission:");
    if (!reason?.trim() || reason.trim().length < 3) return;

    setLoading(true);

    const res = await fetch("/api/admin/reinstate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cycleId,
        submissionId,
        expectedPhase: phase,
        expectedIsDisqualified: true,
        disqualificationType: null,
        reasonCode: "manual_review",
        reasonText: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      }),
    });

    setLoading(false);

    if (res.ok) {
      setDone(true);
      
      window.location.reload();
    } else {
      const error = await res.json().catch(() => null);
      alert(
        res.status === 409
          ? "The phase or submission status changed. Refresh and try again."
          : error?.error ?? "Failed to reinstate submission"
      );
    }
  }

  if (done) {
    return (
      <div style={{ color: "#6ee7b7", marginTop: 8 }}>
        Reinstated
      </div>
    );
  }

  return (
    <button
      onClick={handleReinstate}
      disabled={loading}
      style={{
        marginTop: 8,
        padding: "4px 8px",
        fontSize: 12,
        borderRadius: 4,
        background: "#1f2937",
        border: "1px solid #374151",
        color: "white",
        cursor: "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "Reinstating…" : "Reinstate"}
    </button>
  );
}
