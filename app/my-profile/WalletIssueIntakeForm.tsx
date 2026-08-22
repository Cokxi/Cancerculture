"use client";

import { useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import { TURNSTILE_ACTIONS, TURNSTILE_TOKEN_HEADER } from "@/lib/turnstile/shared";
import {
  WALLET_ISSUE_DESCRIPTION_MAX_LENGTH,
  WALLET_ISSUE_DESCRIPTION_MIN_LENGTH,
  WALLET_ISSUE_REQUEST_ID_HEADER,
  WALLET_ISSUE_SCREENSHOT_MAX_BYTES,
  WALLET_ISSUE_SUBMISSION_ID_HEADER,
  type WalletIssueStatus,
} from "@/lib/walletIssues/contract";

function failureText(code: unknown) {
  switch (code) {
    case "WALLET_ISSUE_SCREENSHOT_INVALID":
      return "Use one JPG, PNG, or WebP screenshot up to 3 MB.";
    case "WALLET_ISSUE_INTAKE_CLOSED":
      return "This Cycle can no longer accept Wallet Issue reports.";
    case "WALLET_ISSUE_INTAKE_COOLDOWN":
      return "Please wait a moment before sending another Wallet Issue report.";
    case "WALLET_ISSUE_TWO_FACTOR_SELF_SERVICE":
      return "Use your 2FA-protected Profile Wallet settings to update the recipient.";
    case "TURNSTILE_REQUIRED":
    case "TURNSTILE_INVALID":
      return "Verification expired or failed. Please verify again.";
    default:
      return "The Wallet Issue report could not be submitted. Please try again.";
  }
}

export default function WalletIssueIntakeForm({
  submissionId,
  initialStatus,
  turnstileSiteKey,
}: {
  submissionId: number;
  initialStatus: WalletIssueStatus | null;
  turnstileSiteKey: string | null;
}) {
  const [status, setStatus] = useState<WalletIssueStatus | null>(initialStatus);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (status) {
    return (
      <p className="mt-3 rounded-lg border border-orange-300/25 bg-orange-500/10 p-3 text-xs text-orange-100" role="status">
        {status === "held"
          ? "Wallet Issue received. It stays private until this Cycle is finalized and only becomes a Team case if this exact Submission wins."
          : status === "promoted"
            ? "This winning Submission has an active Wallet Issue case."
            : status === "resolved"
              ? "The Wallet Issue for this Submission was resolved. Final confirmation remains yours."
              : "This report was not relevant to a win and will be permanently deleted after 14 days."}
      </p>
    );
  }

  async function submit() {
    if (!token || busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (screenshot && screenshot.size > WALLET_ISSUE_SCREENSHOT_MAX_BYTES) {
        throw new Error("WALLET_ISSUE_SCREENSHOT_INVALID");
      }
      const requestId = crypto.randomUUID();
      const form = new FormData();
      form.set("desiredRecipient", address.trim());
      form.set("description", description.trim());
      if (screenshot) form.set("screenshot", screenshot);
      const response = await fetch("/api/wallet-issues/intakes", {
        method: "POST",
        headers: {
          [TURNSTILE_TOKEN_HEADER]: token,
          [WALLET_ISSUE_REQUEST_ID_HEADER]: requestId,
          [WALLET_ISSUE_SUBMISSION_ID_HEADER]: String(submissionId),
        },
        body: form,
      });
      const result = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "WALLET_ISSUE_UNAVAILABLE");
      setStatus("held");
      setOpen(false);
    } catch (error) {
      setMessage(failureText(error instanceof Error ? error.message : null));
    } finally {
      setToken(null);
      setResetKey((value) => value + 1);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 min-h-11 w-full rounded-lg border border-orange-300/35 px-3 py-2 text-sm text-orange-100 hover:bg-orange-500/10">
        Report Wallet Issue for this Submission
      </button>
    );
  }

  const valid = address.trim().length >= 32 &&
    description.trim().length >= WALLET_ISSUE_DESCRIPTION_MIN_LENGTH &&
    description.trim().length <= WALLET_ISSUE_DESCRIPTION_MAX_LENGTH && token;
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-orange-300/30 bg-black/40 p-3 text-left">
      <p className="text-xs text-white/70">
        Send this before Cycle finalization. It is tied only to Submission #{submissionId}.
      </p>
      <label className="block text-xs text-white/75">
        Correct SOL recipient
        <input value={address} onChange={(event) => setAddress(event.target.value.slice(0, 44))} autoComplete="off" className="mt-1 min-h-11 w-full rounded-lg border border-white/15 bg-black px-3 font-mono text-sm" />
      </label>
      <label className="block text-xs text-white/75">
        What is wrong? ({WALLET_ISSUE_DESCRIPTION_MIN_LENGTH}–{WALLET_ISSUE_DESCRIPTION_MAX_LENGTH} characters)
        <textarea value={description} onChange={(event) => setDescription(event.target.value.slice(0, WALLET_ISSUE_DESCRIPTION_MAX_LENGTH))} className="mt-1 min-h-28 w-full rounded-lg border border-white/15 bg-black p-3 text-sm" />
      </label>
      <label className="block text-xs text-white/75">
        Screenshot (optional, JPG/PNG/WebP, max. 3 MB)
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" />
      </label>
      <TurnstileWidget action={TURNSTILE_ACTIONS.walletIssueIntake} siteKey={turnstileSiteKey} resetKey={resetKey} onTokenChange={setToken} />
      {message ? <p role="alert" className="text-xs text-red-300">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!valid || busy} onClick={() => void submit()} className="min-h-11 rounded-lg bg-orange-500 px-4 py-2 font-semibold text-black disabled:opacity-40">
          {busy ? "Sending…" : "Send Wallet Issue"}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm">Cancel</button>
      </div>
    </div>
  );
}
