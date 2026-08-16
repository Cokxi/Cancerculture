"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { validateSolRecipientAddress } from "@/lib/solana/address";

type WalletStatus = {
  factorActive: boolean;
  walletAddress: string | null;
  version: number | null;
  updatedAt: string | null;
};

type WalletMode = "add" | "replace" | "remove" | null;

type PendingMutation = {
  operationId: string;
  expectedVersion: number;
  address: string | null;
  confirmation: "SAVE SOL PROFILE WALLET" | "REMOVE SOL PROFILE WALLET";
};

const buttonClass =
  "min-h-11 cursor-pointer rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/70 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "min-h-11 w-full rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm text-white outline-none focus:border-orange-300 focus-visible:ring-2 focus-visible:ring-orange-300";

class WalletRequestError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = "WalletRequestError";
    this.code = code;
  }
}

async function requestJson(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new WalletRequestError("NETWORK_ERROR");
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new WalletRequestError(
      typeof body?.error === "string" ? body.error : "SOL_WALLET_UNAVAILABLE"
    );
  }
  return body;
}

function messageFor(code: string) {
  switch (code) {
    case "NOT_AUTHENTICATED":
      return "Sign in with Discord to manage your private SOL recipient.";
    case "MEMBERSHIP_PENDING":
      return "Discord membership verification is still pending. Try again after it completes.";
    case "NOT_IN_DISCORD":
      return "An active CancerCulture Discord membership is required for a Profile Wallet.";
    case "TWO_FACTOR_CODE_INVALID":
      return "That authenticator or recovery code is not valid.";
    case "TOTP_STEP_REPLAYED":
      return "That authenticator time window was already used. Wait for the next code.";
    case "TWO_FACTOR_RATE_LIMITED":
      return "Too many verification attempts. Please wait before trying again.";
    case "FRESH_STEP_UP_REQUIRED":
      return "The five-minute wallet approval is missing, expired, or already used. Verify again.";
    case "SOL_WALLET_ADDRESS_INVALID":
      return "Enter a canonical Base58 SOL public key that decodes to 32 bytes and is suitable as a recipient.";
    case "SOL_WALLET_STALE":
      return "This wallet changed in another tab. The latest value was reloaded; review it before trying again.";
    case "SOL_WALLET_NO_CHANGE":
      return "The requested address is already saved. The one-time approval was consumed and no wallet change was made.";
    case "NETWORK_ERROR":
    case "SOL_WALLET_UNAVAILABLE":
      return "The result could not be confirmed. Retry the same operation so CancerCulture can resolve it safely.";
    default:
      return "The private SOL Profile Wallet is temporarily unavailable. No unconfirmed change will be assumed.";
  }
}

export default function SolProfileWalletSettings() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<WalletMode>(null);
  const [address, setAddress] = useState("");
  const [stepUpCode, setStepUpCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const actionHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const validation = useMemo(
    () => (mode === "remove" ? null : validateSolRecipientAddress(address)),
    [address, mode]
  );

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      setStatus((await requestJson("/api/account/sol-wallet")) as WalletStatus);
    } catch (requestError) {
      const code = (requestError as WalletRequestError).code;
      setStatus(null);
      setError(messageFor(code));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (mode) actionHeadingRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const resetAction = () => {
    setMode(null);
    setAddress("");
    setStepUpCode("");
    setConfirmed(false);
    setPending(null);
  };

  const applyMutation = async (mutation: PendingMutation) => {
    await requestJson("/api/account/sol-wallet", {
      method: "PUT",
      body: JSON.stringify(mutation),
    });
    resetAction();
    setNotice(
      mutation.address === null
        ? "Your private SOL Profile Wallet was removed."
        : "Your private SOL Profile Wallet was saved."
    );
    await loadStatus();
  };

  const handleMutationError = async (requestError: unknown) => {
    const code = (requestError as WalletRequestError).code;
    setError(messageFor(code));
    if (code !== "NETWORK_ERROR" && code !== "SOL_WALLET_UNAVAILABLE") {
      setPending(null);
      setStepUpCode("");
      await loadStatus();
    }
  };

  const submit = async () => {
    if (busy || !status || status.version === null || !mode) return;
    if (mode !== "remove" && validation?.ok !== true) {
      setError(messageFor("SOL_WALLET_ADDRESS_INVALID"));
      return;
    }
    if (!confirmed) return;
    const requestedAddress =
      mode === "remove"
        ? null
        : validation?.ok === true
          ? validation.address
          : null;
    if (mode !== "remove" && requestedAddress === null) return;

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const mutation: PendingMutation = {
        operationId: crypto.randomUUID(),
        expectedVersion: status.version,
        address: requestedAddress,
        confirmation:
          mode === "remove"
            ? "REMOVE SOL PROFILE WALLET"
            : "SAVE SOL PROFILE WALLET",
      };
      setPending(mutation);
      await requestJson("/api/account/two-factor/step-up", {
        method: "POST",
        body: JSON.stringify({
          code: stepUpCode,
          purpose: "sol_wallet_change",
        }),
      });
      setStepUpCode("");
      await applyMutation(mutation);
    } catch (requestError) {
      await handleMutationError(requestError);
    } finally {
      setBusy(false);
    }
  };

  const retryPending = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await applyMutation(pending);
    } catch (requestError) {
      await handleMutationError(requestError);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status) {
    return (
      <section className="rounded-xl border border-white/10 bg-black/30 p-5" aria-busy="true">
        <p className="text-sm text-white/65" role="status">Loading private SOL Profile Wallet…</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-black/30 p-5 sm:p-6" aria-labelledby="sol-wallet-title" aria-busy={busy}>
      <h3 id="sol-wallet-title" className="text-xl font-semibold text-white">
        My Solana Wallet
      </h3>

      {error ? (
        <p ref={errorRef} tabIndex={-1} className="mt-4 rounded-lg border border-red-300/25 bg-red-950/30 p-3 text-sm text-red-200 outline-none" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-4 rounded-lg border border-emerald-300/25 bg-emerald-950/20 p-3 text-sm text-emerald-100" role="status">
          {notice}
        </p>
      ) : null}

      {!status ? null : !status.factorActive ? (
        <div className="mt-5 rounded-xl border border-orange-300/25 bg-orange-950/15 p-4 text-sm leading-relaxed text-orange-100">
          You can save or change your wallet only with two-factor
          authentication (2FA) enabled. Enable 2FA in Settings → Security first.
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-xl border border-white/10 bg-black/35 p-4">
            <p className="text-sm font-semibold text-white/80">Saved private SOL recipient</p>
            {status.walletAddress ? (
              <p className="mt-2 break-all font-mono text-sm text-white" data-private-sol-wallet>
                {status.walletAddress}
              </p>
            ) : (
              <p className="mt-2 text-sm text-white/60">No wallet saved yet.</p>
            )}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button type="button" className={buttonClass} onClick={() => { setMode(status.walletAddress ? "replace" : "add"); setAddress(""); setConfirmed(false); setError(null); setNotice(null); }}>
                {status.walletAddress ? "Change wallet" : "Add wallet"}
              </button>
              {status.walletAddress ? (
                <button type="button" className={`${buttonClass} border-red-300/30 text-red-100`} onClick={() => { setMode("remove"); setAddress(""); setConfirmed(false); setError(null); setNotice(null); }}>
                  Remove saved wallet
                </button>
              ) : null}
            </div>
          </div>

          {mode ? (
            <div className="mt-5 rounded-xl border border-orange-300/25 bg-black/35 p-4 sm:p-5">
              <h4 ref={actionHeadingRef} tabIndex={-1} className="font-semibold text-white outline-none">
                {mode === "add" ? "Add your wallet" : mode === "replace" ? "Change your wallet" : "Remove your wallet"}
              </h4>
              {mode !== "remove" ? (
                <>
                  <label htmlFor="sol-profile-wallet-address" className="mt-4 block text-sm font-semibold text-white/85">
                    SOL recipient address
                  </label>
                  <input id="sol-profile-wallet-address" value={address} onChange={(event) => setAddress(event.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} className={`${inputClass} mt-2 font-mono`} />
                  {address && validation?.ok !== true ? (
                    <p className="mt-2 text-sm text-red-200">
                      Use a Base58 public key that decodes to exactly 32 bytes; the all-zero system address is not accepted.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-white/70">
                  This removes the reusable account recipient only. It does not
                  alter Submission data or any future locked payout record.
                </p>
              )}

              <label className="mt-4 flex gap-3 text-sm leading-relaxed text-white/80">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                {mode === "remove"
                  ? "I deliberately want to remove this private Profile Wallet."
                  : "I checked the complete recipient and understand that CancerCulture does not verify who controls it."}
              </label>
              <label htmlFor="sol-wallet-step-up-code" className="mt-4 block text-sm font-semibold text-white/85">
                Current authenticator or unused recovery code
              </label>
              <input id="sol-wallet-step-up-code" value={stepUpCode} onChange={(event) => setStepUpCode(event.target.value)} autoCapitalize="characters" autoComplete="one-time-code" className={`${inputClass} mt-2`} />
              <p className="mt-2 text-xs leading-relaxed text-white/55">
                Approval is bound to this Website session, works once, and
                expires after at most five minutes.
              </p>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button type="button" disabled={busy || !confirmed || stepUpCode.trim().length < 6 || (mode !== "remove" && validation?.ok !== true)} onClick={() => void submit()} className={buttonClass}>
                  {busy ? "Working…" : "Verify and apply"}
                </button>
                <button type="button" disabled={busy} onClick={resetAction} className={buttonClass}>Cancel</button>
              </div>
              {pending ? (
                <div className="mt-4 rounded-lg border border-orange-300/25 bg-orange-950/20 p-3">
                  <p className="text-sm leading-relaxed text-orange-100">
                    The result is not confirmed. Retry uses the same one-time
                    operation identifier and cannot apply the change twice.
                  </p>
                  <button type="button" disabled={busy} onClick={() => void retryPending()} className={`${buttonClass} mt-3`}>
                    Retry same operation
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
