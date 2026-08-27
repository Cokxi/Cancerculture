"use client";

import { useState } from "react";
import {
  addToOverwatch,
  prepareAddToOverwatch,
} from "@/app/admin/actions/userOverwatch";

type PreparedAdd = Readonly<{
  expectedState: "absent" | "removed";
  expectedRowVersion: number;
}>;

export default function UserOverwatchAddAction({
  targetDiscordUserId,
}: {
  targetDiscordUserId: string;
}) {
  const [prepared, setPrepared] = useState<PreparedAdd | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function prepare() {
    setPending(true);
    setMessage(null);
    setStale(false);
    try {
      const result = await prepareAddToOverwatch(targetDiscordUserId);
      if (!result.success) {
        setMessage(result.message);
        setStale(result.stale);
        return;
      }
      if (result.target.currentState === "active") {
        setPrepared(null);
        setMessage("This user already has an active Overwatch entry.");
        return;
      }
      setPrepared({
        expectedState: result.target.currentState,
        expectedRowVersion: result.target.rowVersion,
      });
    } catch {
      setMessage("Overwatch preparation is temporarily unavailable.");
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    const internalReason = reason.trim();
    if (
      !prepared || internalReason.length < 3 || internalReason.length > 1000
    ) return;
    if (!window.confirm(
      "Add this exact user to Overwatch? This creates permanent Team-only audit history. It does not flag, warn, sanction, notify, or change the user's participation."
    )) return;

    setPending(true);
    setMessage(null);
    setStale(false);
    try {
      const result = await addToOverwatch({
        targetDiscordUserId,
        expectedState: prepared.expectedState,
        expectedRowVersion: prepared.expectedRowVersion,
        reason: internalReason,
        requestId: crypto.randomUUID(),
      });
      if (!result.success) {
        setMessage(result.message);
        setStale(result.stale);
        setPrepared(null);
        return;
      }
      setReason("");
      setPrepared(null);
      setMessage(result.receipt.replayed
        ? "The existing safe Add receipt was recovered."
        : `Added to Overwatch as generation ${result.receipt.generation}.`);
    } catch {
      setMessage("Overwatch Add is temporarily unavailable. No confirmed result was received.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section data-user-overwatch-add style={{ marginTop: 8, fontSize: 12 }}>
      {!prepared ? (
        <button
          type="button"
          disabled={pending}
          onClick={prepare}
          style={{
            border: "1px solid #818cf8",
            borderRadius: 999,
            padding: "5px 10px",
            background: "rgba(99,102,241,.12)",
            color: "#c7d2fe",
            cursor: pending ? "not-allowed" : "pointer",
            opacity: pending ? 0.55 : 1,
          }}
        >
          {pending ? "Checking Overwatch…" : "Add to Overwatch"}
        </button>
      ) : (
        <div
          style={{
            maxWidth: 360,
            border: "1px solid rgba(129,140,248,.45)",
            borderRadius: 8,
            padding: 9,
            background: "rgba(49,46,129,.12)",
          }}
        >
          <label
            htmlFor={`overwatch-add-reason-${targetDiscordUserId}`}
            style={{ display: "block", fontWeight: 700 }}
          >
            Internal Overwatch reason <span aria-hidden="true">*</span>
          </label>
          <textarea
            id={`overwatch-add-reason-${targetDiscordUserId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            minLength={3}
            maxLength={1000}
            required
            disabled={pending}
            placeholder="Explain why a Team second opinion is useful."
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
            {reason.length}/1000 · Team-only immutable audit history
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 7 }}>
            <button
              type="button"
              disabled={
                pending || reason.trim().length < 3 ||
                reason.trim().length > 1000
              }
              onClick={submit}
              style={{
                border: "1px solid #818cf8",
                borderRadius: 6,
                background: "rgba(99,102,241,.2)",
                color: "#e0e7ff",
                cursor: pending ? "not-allowed" : "pointer",
                padding: "6px 10px",
                fontWeight: 700,
              }}
            >
              {pending ? "Adding…" : "Confirm Add"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPrepared(null);
                setReason("");
              }}
              style={{ cursor: pending ? "not-allowed" : "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {message ? (
        <p
          role="status"
          style={{ marginTop: 6, color: stale ? "#fbbf24" : "#c7d2fe" }}
        >
          {message}
        </p>
      ) : null}
      {stale ? (
        <button
          type="button"
          disabled={pending}
          onClick={prepare}
          style={{ marginTop: 4, textDecoration: "underline", cursor: "pointer" }}
        >
          Check current Overwatch state
        </button>
      ) : null}
    </section>
  );
}
