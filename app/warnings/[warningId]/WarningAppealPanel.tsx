"use client";

import { useState } from "react";

type AppealStatus = Readonly<{
  appealable: boolean;
  status: "submitted" | "upheld" | "withdrawn" | null;
}>;

export default function WarningAppealPanel({
  warningId,
  initialStatus,
}: {
  warningId: string;
  initialStatus: AppealStatus;
}) {
  const [appealStatus, setAppealStatus] = useState(initialStatus.status);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const trimmedLength = text.trim().length;

  async function submit() {
    if (trimmedLength < 20 || trimmedLength > 1000) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/warnings/${warningId}/appeal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appealText: text, requestId: crypto.randomUUID() }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result.error ?? "UNAVAILABLE"));
      setAppealStatus("submitted");
      setText("");
      setMessage("Your Appeal was submitted to the CancerCulture Team.");
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNAVAILABLE";
      setMessage(code === "already_submitted"
        ? "An Appeal has already been submitted for this Warning."
        : code === "withdrawn"
          ? "This Warning was withdrawn and can no longer be appealed."
          : "The Appeal could not be submitted. Please reload and try again.");
    } finally {
      setBusy(false);
    }
  }

  const statusCopy = appealStatus === "submitted"
    ? "Submitted — the CancerCulture Team will review this Appeal. The Warning remains unchanged while review is pending."
    : appealStatus === "upheld"
      ? "Reviewed — the Warning was upheld."
      : appealStatus === "withdrawn"
        ? "Reviewed — the Warning was withdrawn."
        : null;

  return (
    <section aria-labelledby="warning-appeal-title" className="mt-7 rounded-xl border border-white/10 bg-white/[0.035] p-4">
      <h2 id="warning-appeal-title" className="text-lg font-semibold text-white">Appeal this Warning</h2>
      {statusCopy ? (
        <p className="mt-2 text-sm leading-relaxed text-white/70">{statusCopy}</p>
      ) : initialStatus.appealable ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-white/65">
            Explain why you believe this Warning should be reviewed. You can submit one Appeal for this Warning. Submitting does not pause, shorten, or remove it.
          </p>
          <label htmlFor="warning-appeal-text" className="mt-4 block text-sm font-semibold text-white/80">
            Appeal explanation
          </label>
          <textarea
            id="warning-appeal-text"
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, 1000))}
            minLength={20}
            maxLength={1000}
            disabled={busy}
            className="mt-2 min-h-36 w-full rounded-lg border border-white/15 bg-black/55 p-3 text-white outline-none focus:border-[var(--orange-main)] disabled:opacity-60"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-white/50">{trimmedLength}/1000 characters · minimum 20</p>
            <button
              type="button"
              disabled={busy || trimmedLength < 20 || trimmedLength > 1000}
              onClick={() => void submit()}
              className="min-h-11 rounded-lg bg-[var(--orange-main)] px-4 py-2 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? "Submitting…" : "Submit Appeal"}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-white/65">This Warning is not eligible for an Appeal.</p>
      )}
      {message ? <p className="mt-3 text-sm text-white/75" role="status">{message}</p> : null}
    </section>
  );
}
