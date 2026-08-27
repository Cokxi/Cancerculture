"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { removeFromOverwatch } from "@/app/admin/actions/userOverwatch";

export default function UserOverwatchRemoveAction({
  targetDiscordUserId,
  entryId,
  expectedRowVersion,
}: {
  targetDiscordUserId: string;
  entryId: string;
  expectedRowVersion: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function submit() {
    const internalReason = reason.trim();
    if (internalReason.length < 3 || internalReason.length > 1000) return;
    if (!window.confirm(
      "Remove this exact active Overwatch generation? The Add and Remove reasons, actor snapshots, request receipt, and audit events remain permanently preserved."
    )) return;

    setPending(true);
    setMessage(null);
    setStale(false);
    try {
      const result = await removeFromOverwatch({
        targetDiscordUserId,
        entryId,
        expectedRowVersion,
        reason: internalReason,
        requestId: crypto.randomUUID(),
      });
      if (!result.success) {
        setMessage(result.message);
        setStale(result.stale);
        return;
      }
      setReason("");
      setMessage(result.receipt.replayed
        ? "The existing safe Remove receipt was recovered."
        : "This generation was removed from the active queue and retained in immutable history.");
      router.refresh();
    } catch {
      setMessage("Overwatch Remove is temporarily unavailable. No confirmed result was received.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-user-overwatch-remove
      style={{
        marginTop: 12,
        borderTop: "1px solid rgba(255,255,255,.12)",
        paddingTop: 10,
      }}
    >
      <label
        htmlFor={`overwatch-remove-reason-${entryId}`}
        style={{ display: "block", fontWeight: 700 }}
      >
        Internal removal reason <span aria-hidden="true">*</span>
      </label>
      <textarea
        id={`overwatch-remove-reason-${entryId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        minLength={3}
        maxLength={1000}
        required
        disabled={pending}
        placeholder="Explain why this second-opinion bookmark is no longer active."
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
      <div style={{ marginTop: 4, opacity: 0.65 }}>
        {reason.length}/1000 · closes only this active generation
      </div>
      <button
        type="button"
        disabled={
          pending || reason.trim().length < 3 || reason.trim().length > 1000
        }
        onClick={submit}
        style={{
          marginTop: 7,
          border: "1px solid rgba(248,113,113,.7)",
          borderRadius: 6,
          background: "rgba(127,29,29,.2)",
          color: "#fecaca",
          cursor: pending ? "not-allowed" : "pointer",
          padding: "6px 10px",
          fontWeight: 700,
        }}
      >
        {pending ? "Removing…" : "Remove from Overwatch"}
      </button>
      {message ? (
        <p
          role="status"
          style={{ marginTop: 7, color: stale ? "#fbbf24" : "#d1fae5" }}
        >
          {message}
        </p>
      ) : null}
      {stale ? (
        <button
          type="button"
          onClick={() => router.refresh()}
          style={{ marginTop: 5, textDecoration: "underline", cursor: "pointer" }}
        >
          Refresh Overwatch
        </button>
      ) : null}
    </section>
  );
}
