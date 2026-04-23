"use client";

import { useState } from "react";
import CycleHudControls from "./CycleHudControls";
import type { SponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";

export default function CycleControls({
  initialNextTheme,
  initialSponsoredDraft,
}: {
  initialNextTheme: string;
  initialSponsoredDraft: SponsoredCycleDraft;
}) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [startTheme, setStartTheme] = useState("");
  const [nextTheme, setNextTheme] = useState(initialNextTheme);

  function getErrorMessage(error: unknown) {
    return error instanceof Error
      ? error.message
      : "Unknown error";
  }

  async function startCycle() {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/cycles/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endsAt: new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000
          ).toISOString(),
          theme: startTheme,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Unknown error");
      }

      setMessage("Cycle successfully started");
      setStartTheme("");
    } catch (error) {
      setMessage("Error: " + getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function endCycle() {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/cycles/end", {
        method: "POST",
      });

      const text = await res.text();
      const data = text ? JSON.parse(text) : null;

      if (!res.ok) {
        throw new Error(data?.error || "Unknown error");
      }

      setMessage("Cycle finalization started");
    } catch (error) {
      setMessage("Error: " + getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function saveNextCycleTheme() {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/cycles/next-theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          theme: nextTheme,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Unknown error");
      }

      setNextTheme(data.nextTheme ?? "");
      setMessage(
        data.nextTheme
          ? "Next cycle theme saved"
          : "Next cycle theme cleared"
      );
    } catch (error) {
      setMessage("Error: " + getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          value={startTheme}
          onChange={(e) => setStartTheme(e.target.value)}
          placeholder="Cycle theme for immediate start (optional)"
          style={{
            padding: "6px 10px",
            fontSize: 14,
            minWidth: 260,
          }}
        />

        <button
          onClick={startCycle}
          disabled={loading}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Starting..." : "Start Cycle"}
        </button>

        <button
          onClick={endCycle}
          disabled={loading}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          End Cycle
        </button>
      </div>

      <div
        style={{
          marginTop: 20,
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          value={nextTheme}
          onChange={(e) => setNextTheme(e.target.value)}
          placeholder="Next cycle theme"
          style={{
            padding: "6px 10px",
            fontSize: 14,
            minWidth: 260,
          }}
        />

        <button
          onClick={saveNextCycleTheme}
          disabled={loading}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Saving..." : "Save Next Theme"}
        </button>
      </div>

      <CycleHudControls
        initialSponsoredDraft={initialSponsoredDraft}
      />

      {message && (
        <p style={{ marginTop: 16 }}>{message}</p>
      )}
    </div>
  );
}
