"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import CycleHudControls from "./CycleHudControls";
import type { SponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";

export default function CycleControls({
  initialNextTheme,
  initialSponsoredDraft,
  currentCycleId,
  currentCycleNumber,
  currentPhaseStatus,
  pausedFromStatus,
  initialVotesPerUser,
  initialSubmissionsPerUser,
  initialUploadSuccessCooldownSeconds,
  resetPreview,
}: {
  initialNextTheme: string;
  initialSponsoredDraft: SponsoredCycleDraft;
  currentCycleId: number | null;
  currentCycleNumber: number | null;
  currentPhaseStatus: string | null;
  pausedFromStatus: string | null;
  initialVotesPerUser: number;
  initialSubmissionsPerUser: number;
  initialUploadSuccessCooldownSeconds: number;
  resetPreview: {
    submissions: number;
    votes: number;
    affectedSubmitters: number;
  };
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [startTheme, setStartTheme] = useState("");
  const [submissionsPerUser, setSubmissionsPerUser] = useState(
    initialSubmissionsPerUser
  );
  const [uploadSuccessCooldownSeconds, setUploadSuccessCooldownSeconds] =
    useState(initialUploadSuccessCooldownSeconds);
  const [nextTheme, setNextTheme] = useState(initialNextTheme);
  const [resetReason, setResetReason] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");
  const canFinalize =
    currentCycleId !== null &&
    (currentPhaseStatus === "voting_closed" ||
      currentPhaseStatus === "finalizing" ||
      currentPhaseStatus === "active");
  const canReset =
    currentCycleId !== null &&
    [
      "draft",
      "submission_open",
      "submission_closed",
      "voting_open",
      "voting_closed",
      "paused",
      "finalizing",
      "active",
    ].includes(currentPhaseStatus ?? "");
  const canStart =
    currentCycleId === null || currentPhaseStatus === "draft";
  const expectedResetConfirmation =
    currentCycleId === null ? "" : `RESET ${currentCycleId}`;

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
          cycleId:
            currentPhaseStatus === "draft" ? currentCycleId : null,
          theme: startTheme,
          submissionsPerUser,
          uploadSuccessCooldownSeconds,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Unknown error");
      }

      setMessage(
        `Public Cycle #${data.cycle.publicNumber} successfully started (internal ID #${data.cycle.id})`
      );
      setStartTheme("");
      router.refresh();
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cycleId: currentCycleId }),
      });

      const text = await res.text();
      const data = text ? JSON.parse(text) : null;

      if (!res.ok) {
        throw new Error(data?.error || "Unknown error");
      }

      setMessage(
        `Cycle finalized: ${data.rankedSubmissionCount} ranked, ${data.winnerCount} winner${data.winnerCount === 1 ? "" : "s"}`
      );
      router.refresh();
    } catch (error) {
      setMessage("Error: " + getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function resetCycle() {
    if (currentCycleId === null) {
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/cycles/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycleId: currentCycleId,
          reason: resetReason,
          confirmation: resetConfirmation,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Unknown error");
      }

      const reset = data.reset;
      const baseMessage = reset.alreadyReset
        ? `Public Cycle #${reset.cycleNumber} (internal ID #${reset.cycleId}) was already a clean reset draft.`
        : `Public Cycle #${reset.cycleNumber} (internal ID #${reset.cycleId}) reset to Draft: ${reset.removedSubmissions} submissions and ${reset.removedVotes} votes removed.`;

      setMessage(
        data.cleanup?.warning
          ? `${baseMessage} ${data.cleanup.warning}`
          : baseMessage
      );
      setResetReason("");
      setResetConfirmation("");
      router.refresh();
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

        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Submissions per user
          <input
            type="number"
            min={1}
            max={20}
            value={submissionsPerUser}
            onChange={(event) =>
              setSubmissionsPerUser(Number(event.target.value))
            }
            disabled={!canStart || loading}
            style={{ padding: "6px 10px", width: 100 }}
          />
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          Successful upload cooldown (seconds)
          <input
            type="number"
            min={30}
            max={300}
            value={uploadSuccessCooldownSeconds}
            onChange={(event) =>
              setUploadSuccessCooldownSeconds(Number(event.target.value))
            }
            disabled={!canStart || loading}
            style={{ padding: "6px 10px", width: 120 }}
          />
        </label>

        <button
          onClick={startCycle}
          disabled={loading || !canStart}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor:
              loading || !canStart ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Working..." : "Start Cycle"}
        </button>

        <button
          onClick={endCycle}
          disabled={loading || !canFinalize}
          style={{
            padding: "8px 16px",
            fontSize: 16,
            cursor:
              loading || !canFinalize
                ? "not-allowed"
                : "pointer",
          }}
        >
          Finalize Cycle
        </button>
      </div>

      {canReset && currentCycleId !== null ? (
        <section
          style={{
            marginTop: 24,
            maxWidth: 680,
            border: "1px solid #b91c1c",
            borderRadius: 10,
            padding: 16,
            background: "rgba(127, 29, 29, 0.08)",
          }}
        >
          <h2 style={{ margin: 0, color: "#b91c1c" }}>
            Reset Cycle
          </h2>
          <p style={{ lineHeight: 1.5 }}>
            Reset {currentCycleNumber
              ? `public Cycle #${currentCycleNumber} (internal ID #${currentCycleId})`
              : `Cycle internal ID #${currentCycleId}`}? All submissions, votes and
            unfinished result data from this attempt will be removed. The
            same public Cycle number will return to Draft and can be started again.
            No public bot announcement will be sent.
          </p>
          <p>
            <strong>Current attempt:</strong>{" "}
            {resetPreview.submissions} submissions, {resetPreview.votes}{" "}
            votes, {resetPreview.affectedSubmitters} affected submitters
          </p>

          <label
            style={{ display: "block", marginTop: 12, fontWeight: 600 }}
          >
            Mandatory reason
          </label>
          <textarea
            value={resetReason}
            onChange={(event) => setResetReason(event.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Why is this recovery reset required?"
            style={{
              display: "block",
              width: "100%",
              marginTop: 6,
              padding: 10,
            }}
          />

          <label
            style={{ display: "block", marginTop: 12, fontWeight: 600 }}
          >
            Type {expectedResetConfirmation} to confirm
          </label>
          <input
            value={resetConfirmation}
            onChange={(event) =>
              setResetConfirmation(event.target.value)
            }
            placeholder={expectedResetConfirmation}
            autoComplete="off"
            style={{
              display: "block",
              width: "100%",
              marginTop: 6,
              padding: 10,
            }}
          />

          <button
            type="button"
            onClick={resetCycle}
            disabled={
              loading ||
              resetReason.trim().length === 0 ||
              resetConfirmation.trim() !== expectedResetConfirmation
            }
            style={{
              marginTop: 14,
              padding: "10px 16px",
              border: 0,
              borderRadius: 6,
              background: "#b91c1c",
              color: "white",
              fontWeight: 700,
              cursor:
                loading ||
                resetReason.trim().length === 0 ||
                resetConfirmation.trim() !== expectedResetConfirmation
                  ? "not-allowed"
                  : "pointer",
              opacity:
                loading ||
                resetReason.trim().length === 0 ||
                resetConfirmation.trim() !== expectedResetConfirmation
                  ? 0.55
                  : 1,
            }}
          >
            {loading ? "RESETTING..." : "RESET CYCLE"}
          </button>
        </section>
      ) : null}

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
        currentPhaseStatus={currentPhaseStatus}
        pausedFromStatus={pausedFromStatus}
        initialVotesPerUser={initialVotesPerUser}
      />

      {currentPhaseStatus === "voting_closed" ? (
        <Link
          href="/admin/cycles/end-moderation"
          className="mt-5 inline-flex cursor-pointer rounded-md border border-orange-300/60 bg-orange-500/15 px-4 py-2 font-semibold text-orange-100 hover:bg-orange-500/25"
        >
          Open Cycle End Moderation
        </Link>
      ) : null}

      {message && (
        <p style={{ marginTop: 16 }}>{message}</p>
      )}
    </div>
  );
}
