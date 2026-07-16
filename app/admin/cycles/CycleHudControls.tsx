"use client";

import { updateCycleTimer } from "./updateCycleTimer";
import {
  closeSubmissionPhaseAction,
  closeVotingPhaseAction,
  pauseCurrentPhaseAction,
  resumeCurrentPhaseAction,
  setVotesPerUserAction,
  startVotingPhaseAction,
} from "./phaseActions";
import SponsoredCycleDraftPanel from "./SponsoredCycleDraftPanel";
import type { SponsoredCycleDraft } from "@/lib/cycles/sponsoredCycle";

export default function CycleHudControls({
  initialSponsoredDraft,
  currentPhaseStatus,
  pausedFromStatus,
  initialVotesPerUser,
}: {
  initialSponsoredDraft: SponsoredCycleDraft;
  currentPhaseStatus: string | null;
  pausedFromStatus: string | null;
  initialVotesPerUser: number;
}) {
  const phaseLabel =
    currentPhaseStatus === "paused" && pausedFromStatus
      ? `PAUSED (${pausedFromStatus.replaceAll("_", " ")})`
      : currentPhaseStatus?.replaceAll("_", " ") ?? "NO ACTIVE PHASE";

  return (
    <div
      className="
        mt-10
        p-5
        rounded-xl
        bg-[var(--orange-main)]
        text-white
        flex flex-col gap-4
        max-w-md
      "
    >
      <span className="font-['Permanent_Marker'] text-sm tracking-wide">
        CYCLE HUD
      </span>
      <p className="text-sm text-white/80">
        Timer applies to the current phase: submissions first,
        voting after submissions close.
      </p>
      <p className="text-xs uppercase tracking-wide text-white/70">
        Current: {phaseLabel}
      </p>

      
      {currentPhaseStatus === "submission_open" ||
      currentPhaseStatus === "voting_open" ||
      currentPhaseStatus === "active" ? (
      <form action={updateCycleTimer} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            name="timer_hours"
            type="number"
            min="0"
            placeholder="h"
            className="w-20 px-3 py-2 rounded-md bg-white/90 text-black"
          />

          <input
            name="timer_minutes"
            type="number"
            min="0"
            placeholder="m"
            className="w-20 px-3 py-2 rounded-md bg-white/90 text-black"
          />
        </div>

        <button
          type="submit"
          className="
            py-2
            rounded-md
            bg-black/70
            hover:bg-black
            transition
            font-['Permanent_Marker']
          "
        >
          SET CURRENT PHASE TIMER
        </button>
      </form>
      ) : null}

      {currentPhaseStatus === "submission_open" ? (
        <>
          <form action={setVotesPerUserAction} className="flex flex-col gap-2">
            <label className="text-sm text-white/85">
              Votes per user for voting phase
            </label>
            <div className="flex gap-2">
              <input
                name="votes_per_user"
                type="number"
                min="1"
                max="10"
                defaultValue={initialVotesPerUser}
                className="w-20 rounded-md bg-white/90 px-3 py-2 text-black"
              />
              <button
                type="submit"
                className="flex-1 rounded-md bg-black/70 px-3 py-2 font-['Permanent_Marker'] transition hover:bg-black"
              >
                SET VOTES
              </button>
            </div>
          </form>

          <form action={closeSubmissionPhaseAction}>
            <button
              type="submit"
              className="w-full rounded-md bg-black/70 py-2 font-['Permanent_Marker'] transition hover:bg-black"
            >
              END SUBMISSIONS + START VOTING
            </button>
          </form>
        </>
      ) : null}

      {currentPhaseStatus === "voting_open" ? (
        <form action={closeVotingPhaseAction}>
          <button
            type="submit"
            className="w-full rounded-md bg-black/70 py-2 font-['Permanent_Marker'] transition hover:bg-black"
          >
            END VOTING PHASE
          </button>
        </form>
      ) : null}

      {currentPhaseStatus === "submission_closed" ? (
        <form action={startVotingPhaseAction}>
          <button
            type="submit"
            className="w-full rounded-md bg-black/70 py-2 font-['Permanent_Marker'] transition hover:bg-black"
          >
            START VOTING PHASE
          </button>
        </form>
      ) : null}

      {currentPhaseStatus === "submission_open" ||
      currentPhaseStatus === "voting_open" ? (
        <form action={pauseCurrentPhaseAction}>
          <button
            type="submit"
            className="w-full rounded-md border border-white/40 bg-white/10 py-2 font-['Permanent_Marker'] transition hover:bg-white/20"
          >
            PAUSE CURRENT PHASE
          </button>
        </form>
      ) : null}

      {currentPhaseStatus === "paused" ? (
        <form action={resumeCurrentPhaseAction}>
          <button
            type="submit"
            className="w-full rounded-md bg-green-700 py-2 font-['Permanent_Marker'] transition hover:bg-green-600"
          >
            RESUME {pausedFromStatus?.replaceAll("_", " ") ?? "PHASE"}
          </button>
        </form>
      ) : null}

      <SponsoredCycleDraftPanel
        initialDraft={initialSponsoredDraft}
      />
    </div>
  );
}
