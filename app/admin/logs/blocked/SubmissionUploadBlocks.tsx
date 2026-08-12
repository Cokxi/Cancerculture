"use client";

import { useCallback, useEffect, useState } from "react";
import UserProfileLink from "../shared/UserProfileLink";

type UploadBlockState = {
  discord_user_id: string;
  cycle_id: number;
  invalid_attempt_count: number;
  total_invalid_attempt_count: number;
  last_error_code: string | null;
  last_invalid_attempt_at: string | null;
  blocked_at: string | null;
  block_count: number;
  unblocked_at: string | null;
  unblock_reason: string | null;
  display_name: string;
  public_profile_id: string | null;
};

export default function SubmissionUploadBlocks({
  canEmergencyUnblock,
}: {
  canEmergencyUnblock: boolean;
}) {
  const [states, setStates] = useState<UploadBlockState[]>([]);
  const [reasonByKey, setReasonByKey] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/upload-blocks");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "LOAD_FAILED");
    setStates(body.states ?? []);
  }, []);

  useEffect(() => {
    load().catch(() => setError("Upload blocks could not be loaded."));
  }, [load]);

  async function unblock(state: UploadBlockState) {
    const key = `${state.discord_user_id}:${state.cycle_id}`;
    const reason = reasonByKey[key]?.trim() ?? "";
    if (!reason) {
      setError("An unblock reason is required.");
      return;
    }

    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch("/api/admin/upload-blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycleId: state.cycle_id,
          discordUserId: state.discord_user_id,
          reason,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "UNBLOCK_FAILED");
      setReasonByKey((current) => ({ ...current, [key]: "" }));
      await load();
    } catch {
      setError("The upload block could not be removed.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="mb-10 rounded border border-white/15 p-4">
      <h2 className="mb-1 text-lg font-semibold">Submission upload blocks</h2>
      <p className="mb-4 text-sm text-white/60">
        Automatic abuse protection scoped to one user and one cycle. A block
        stops affecting uploads when the next cycle begins. Manual unblocking
        during the current cycle is an audited Admin-only emergency action.
      </p>
      {error ? <p className="mb-3 text-sm text-red-300">{error}</p> : null}
      <div className="space-y-3">
        {states.map((state) => {
          const key = `${state.discord_user_id}:${state.cycle_id}`;
          return (
            <article key={key} className="rounded bg-white/5 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <UserProfileLink
                  discordUserId={state.discord_user_id}
                  label={state.display_name}
                  publicProfileId={state.public_profile_id}
                />
                <span className={state.blocked_at ? "text-red-300" : "text-green-300"}>
                  {state.blocked_at ? "blocked" : "not blocked"}
                </span>
              </div>
              <div className="mt-2 text-white/70">
                Cycle internal ID {state.cycle_id} · current attempts {state.invalid_attempt_count}/5
                · total {state.total_invalid_attempt_count} · blocks {state.block_count}
              </div>
              <div className="mt-1 text-xs text-white/50">
                Last code: {state.last_error_code ?? "—"} · Last attempt:{" "}
                {state.last_invalid_attempt_at
                  ? new Date(state.last_invalid_attempt_at).toLocaleString()
                  : "—"}
              </div>
              {state.blocked_at && canEmergencyUnblock ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    value={reasonByKey[key] ?? ""}
                    onChange={(event) =>
                      setReasonByKey((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    maxLength={500}
                    placeholder="Required unblock reason"
                    className="min-w-64 flex-1 rounded bg-black/30 px-3 py-2"
                  />
                  <button
                    type="button"
                    disabled={busyKey === key}
                    onClick={() => unblock(state)}
                    className="cursor-pointer rounded bg-orange-500 px-3 py-2 text-black disabled:opacity-50"
                  >
                    {busyKey === key ? "Unblocking…" : "Unblock"}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
        {states.length === 0 ? (
          <p className="text-sm text-white/50">No invalid-media attempts recorded.</p>
        ) : null}
      </div>
    </section>
  );
}
