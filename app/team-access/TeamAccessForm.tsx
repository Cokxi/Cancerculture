"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const inputClass =
  "min-h-11 w-full rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-center font-mono text-lg tracking-[0.2em] text-white outline-none focus:border-orange-300 focus-visible:ring-2 focus-visible:ring-orange-300";
const buttonClass =
  "min-h-11 w-full cursor-pointer rounded-lg border border-orange-300/50 bg-orange-300/10 px-4 py-2 font-semibold text-orange-100 outline-none transition hover:bg-orange-300/20 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";

function messageFor(code: string | undefined) {
  switch (code) {
    case "TWO_FACTOR_CODE_INVALID":
      return "That authenticator code is not valid. Check the current code and try again.";
    case "TOTP_STEP_REPLAYED":
      return "That time window was already used. Wait for the next authenticator code.";
    case "TWO_FACTOR_RATE_LIMITED":
      return "Too many attempts. Please wait before trying again.";
    case "TEAM_TOTP_NOT_ACTIVE":
      return "Active two-factor authentication is required for Team Area access.";
    case "NOT_AUTHENTICATED":
      return "Your website session is no longer active. Sign in again.";
    default:
      return "Team verification is temporarily unavailable. No access was granted.";
  }
}

export default function TeamAccessForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/team-access", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.granted !== true) {
        setError(messageFor(typeof body?.error === "string" ? body.error : undefined));
        return;
      }
      router.replace("/admin");
    } catch {
      setError(messageFor(undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <label htmlFor="team-totp-code" className="text-sm font-semibold text-white/85">
        Current authenticator code
      </label>
      <input
        id="team-totp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={8}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
        }}
        className={`${inputClass} mt-2`}
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm leading-relaxed text-red-200">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || code.replace(/[\s-]/gu, "").length !== 6}
        onClick={() => void submit()}
        className={`${buttonClass} mt-4`}
      >
        {busy ? "Verifying…" : "Unlock Team Area"}
      </button>
    </div>
  );
}
