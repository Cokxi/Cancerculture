"use client";

import {
  createModerationIdempotencyKey,
  finishModerationRequest,
  performModerationClientRequest,
  tryBeginModerationRequest,
  waitForModerationPendingPaint,
} from "@/lib/moderation/moderationClientRequest";
import { useRef, useState } from "react";

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
  const requestPendingRef = useRef(false);

  async function handleReinstate() {
    if (!tryBeginModerationRequest(requestPendingRef)) return;

    const reason = prompt("Reason for reinstating this submission:");
    if (!reason?.trim() || reason.trim().length < 3) {
      finishModerationRequest(requestPendingRef);
      return;
    }

    setLoading(true);
    let outcome: Awaited<
      ReturnType<typeof performModerationClientRequest>
    >;
    try {
      outcome = await performModerationClientRequest({
        endpoint: "/api/admin/reinstate",
        body: {
          cycleId,
          submissionId,
          expectedPhase: phase,
          expectedIsDisqualified: true,
          disqualificationType: null,
          reasonCode: "manual_review",
          reasonText: reason.trim(),
          idempotencyKey: createModerationIdempotencyKey(),
        },
        finishPending: async () => {
          finishModerationRequest(requestPendingRef);
          setLoading(false);
          await waitForModerationPendingPaint();
        },
      });
    } finally {
      if (requestPendingRef.current) {
        finishModerationRequest(requestPendingRef);
        setLoading(false);
      }
    }
    if (outcome === "changed") setDone(true);
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
      {loading ? "Reinstating..." : "Reinstate"}
    </button>
  );
}
