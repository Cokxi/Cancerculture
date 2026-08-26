"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { overruleUserWarning } from "@/app/admin/actions/overruleUserWarning";

export default function UserWarningOverruleAction({
  targetDiscordUserId,
  publicWarningId,
  expectedRowVersion,
}: {
  targetDiscordUserId: string;
  publicWarningId: string;
  expectedRowVersion: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function submit() {
    const correctionReason = reason.trim();
    if (correctionReason.length < 3 || correctionReason.length > 1000) return;
    if (!window.confirm(
      "Overrule this exact Warning? This creates an irreversible audit event, recomputes later effective Warnings, and notifies the affected member. The Warning and its evidence will not be deleted or rewritten."
    )) return;

    setPending(true);
    setMessage(null);
    setStale(false);
    try {
      const result = await overruleUserWarning({
        targetDiscordUserId,
        publicWarningId,
        expectedRowVersion,
        reason: correctionReason,
        requestId: crypto.randomUUID(),
      });
      if (!result.success) {
        setMessage(result.message);
        setStale(result.stale);
        return;
      }
      setMessage(result.replayed
        ? "The existing correction receipt was recovered."
        : "Warning overruled. The immutable history and effective projection were updated.");
      router.refresh();
    } catch {
      setMessage("Warning correction is temporarily unavailable. No confirmed result was received.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-user-warning-overrule
      style={{
        marginTop: 9,
        borderTop: "1px solid rgba(255,255,255,.12)",
        paddingTop: 9,
      }}
      aria-label="Overrule this Warning"
    >
      <label
        htmlFor={`warning-overrule-reason-${publicWarningId}`}
        style={{ display: "block", fontWeight: 600 }}
      >
        Internal correction reason <span aria-hidden="true">*</span>
      </label>
      <textarea
        id={`warning-overrule-reason-${publicWarningId}`}
        value={reason}
        rows={3}
        minLength={3}
        maxLength={1000}
        required
        disabled={pending}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Explain why this exact Warning must be corrected."
        style={{
          display: "block",
          width: "100%",
          marginTop: 5,
          border: "1px solid #555",
          borderRadius: 6,
          background: "rgba(0,0,0,.45)",
          color: "white",
          padding: "7px 8px",
          resize: "vertical",
        }}
      />
      <div style={{ marginTop: 4, opacity: 0.6 }}>
        {reason.length}/1000 · saved only in Team audit history
      </div>
      <button
        type="button"
        disabled={pending || reason.trim().length < 3 || reason.trim().length > 1000}
        onClick={submit}
        style={{
          marginTop: 7,
          minHeight: 36,
          border: "1px solid rgba(251,146,60,.7)",
          borderRadius: 6,
          background: "rgba(249,115,22,.16)",
          color: "#fed7aa",
          cursor: pending ? "not-allowed" : "pointer",
          padding: "6px 10px",
          opacity: pending ? 0.55 : 1,
          fontWeight: 700,
        }}
      >
        {pending ? "Correcting…" : "Overrule Warning"}
      </button>
      <p style={{ marginTop: 6, opacity: 0.65 }}>
        This never deletes or rewrites the Warning. A successful correction is permanent audit history.
      </p>
      {message ? (
        <p role="status" style={{ marginTop: 7, color: stale ? "#fbbf24" : "#d1fae5" }}>
          {message}
        </p>
      ) : null}
      {stale ? (
        <button
          type="button"
          onClick={() => router.refresh()}
          style={{ marginTop: 5, textDecoration: "underline", cursor: "pointer" }}
        >
          Refresh Warning history
        </button>
      ) : null}
    </section>
  );
}
