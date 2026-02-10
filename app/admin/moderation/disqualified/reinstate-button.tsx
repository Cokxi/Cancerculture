"use client";

import { useState } from "react";

export default function ReinstateButton({
  submissionId,
}: {
  submissionId: number;
}) {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReinstate() {
    if (!confirm("Reinstate this submission?")) {
      return;
    }

    setLoading(true);

    const res = await fetch("/api/admin/reinstate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ submissionId }),
    });

    setLoading(false);

    if (res.ok) {
      setDone(true);
      // einfacher, sicherer Refresh
      window.location.reload();
    } else {
      alert("Failed to reinstate submission");
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
