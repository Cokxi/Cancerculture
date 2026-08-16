"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_TOKEN_HEADER,
} from "@/lib/turnstile/shared";

type TwoFactorStatus = {
  active: boolean;
  activatedAt: string | null;
  recoveryCodesRemaining: number;
  recoveryEmail: { masked: string; verifiedAt: string | null } | null;
  pendingEnrollment: {
    id: string;
    intent: string | null;
    expiresAt: string | null;
  } | null;
  recoveryTurnstileSiteKey: string | null;
};

type Enrollment = {
  enrollmentId: string;
  expiresAt: string | null;
  qrCodeDataUrl: string;
  manualKey: string;
};

type Action =
  | "replace_factor"
  | "replace_codes"
  | "backup_email"
  | "remove_backup_email"
  | "deactivate"
  | null;

type RecoveryMethod = "recovery_code" | "backup_email" | null;

const buttonClass =
  "min-h-11 cursor-pointer rounded-lg border border-white/20 px-4 py-2 text-sm font-semibold text-white outline-none transition hover:border-orange-300/70 hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "min-h-11 w-full rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm text-white outline-none focus:border-orange-300 focus-visible:ring-2 focus-visible:ring-orange-300";

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error("REQUEST_FAILED") as Error & { code?: string };
    error.code = typeof body?.error === "string" ? body.error : "TWO_FACTOR_UNAVAILABLE";
    throw error;
  }
  return body;
}

function messageFor(code: string | undefined) {
  switch (code) {
    case "NOT_AUTHENTICATED":
      return "Sign in with Discord to manage two-factor authentication.";
    case "TWO_FACTOR_CODE_INVALID":
      return "That code is not valid. Check the current code and try again.";
    case "TOTP_STEP_REPLAYED":
      return "That authenticator time window was already used. Wait for the next code.";
    case "TWO_FACTOR_RATE_LIMITED":
    case "RECOVERY_EMAIL_RATE_LIMITED":
      return "Too many attempts. Please wait before trying again.";
    case "FRESH_STEP_UP_REQUIRED":
      return "The fresh verification expired. Verify again.";
    case "SECURITY_EMAIL_UNAVAILABLE":
      return "Security email is not configured or temporarily unavailable. No recovery token was activated.";
    case "TURNSTILE_REQUIRED":
    case "TURNSTILE_INVALID":
      return "Complete the anti-bot check and try again.";
    default:
      return "Two-factor authentication is temporarily unavailable. No change was made.";
  }
}

export default function TwoFactorSettings() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [recoveryMethod, setRecoveryMethod] = useState<RecoveryMethod>(null);
  const [stepUpCode, setStepUpCode] = useState("");
  const [backupEmail, setBackupEmail] = useState("");
  const [emailToken, setEmailToken] = useState("");
  const [awaitingBackupEmailVerification, setAwaitingBackupEmailVerification] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const actionHeadingRef = useRef<HTMLHeadingElement>(null);
  const emailRecoveryHeadingRef = useRef<HTMLHeadingElement>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus((await requestJson("/api/account/two-factor")) as TwoFactorStatus);
      setLoadErrorCode(null);
    } catch (requestError) {
      const code = (requestError as Error & { code?: string }).code;
      setStatus(null);
      setLoadErrorCode(code ?? "TWO_FACTOR_UNAVAILABLE");
      setError(messageFor(code));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (action) actionHeadingRef.current?.focus();
  }, [action]);

  useEffect(() => {
    if (recoveryMethod === "backup_email") {
      emailRecoveryHeadingRef.current?.focus();
    }
  }, [recoveryMethod]);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (requestError) {
      setError(messageFor((requestError as Error & { code?: string }).code));
    } finally {
      setBusy(false);
    }
  };

  const createEnrollment = async (
    intent: "initial" | "replacement" | "email_recovery"
  ) => {
    const result = (await requestJson("/api/account/two-factor/enrollment", {
        method: "POST",
        body: JSON.stringify({
          intent,
          acknowledgeRecoveryResponsibility: acknowledged,
          ...(intent === "email_recovery" ? { recoveryToken } : {}),
        }),
    })) as Enrollment;
    setEnrollment(result);
    setActivationCode("");
    setRecoveryToken("");
    setAction(null);
    setRecoveryMethod(null);
    setNotice("Scan the new QR code, then enter a current authenticator code to activate it.");
  };

  const beginEnrollment = (intent: "initial" | "replacement" | "email_recovery") =>
    run(() => createEnrollment(intent));

  const activate = () =>
    run(async () => {
      if (!enrollment) return;
      const result = await requestJson("/api/account/two-factor/activation", {
        method: "POST",
        body: JSON.stringify({
          enrollmentId: enrollment.enrollmentId,
          code: activationCode,
        }),
      });
      setRecoveryCodes(result.recoveryCodes as string[]);
      setEnrollment(null);
      setActivationCode("");
      setCodesSaved(false);
      await loadStatus();
    });

  const verifyForAction = () =>
    run(async () => {
      if (!action) return;
      const purpose = {
        replace_factor: "factor_change",
        replace_codes: "recovery_codes_replace",
        backup_email: "backup_email_change",
        remove_backup_email: "backup_email_change",
        deactivate: "factor_deactivation",
      }[action];
      await requestJson("/api/account/two-factor/step-up", {
        method: "POST",
        body: JSON.stringify({ code: stepUpCode, purpose }),
      });
      setStepUpCode("");
      if (action === "replace_factor") {
        await createEnrollment("replacement");
        return;
      }
      if (action === "replace_codes") {
        const result = await requestJson("/api/account/two-factor/recovery-codes", {
          method: "POST",
          body: JSON.stringify({ confirmation: "REPLACE RECOVERY CODES" }),
        });
        setRecoveryCodes(result.recoveryCodes as string[]);
        setCodesSaved(false);
        setAction(null);
        await loadStatus();
        return;
      }
      if (action === "backup_email") {
        const result = await requestJson("/api/account/two-factor/recovery-email", {
          method: "POST",
          body: JSON.stringify({ email: backupEmail }),
        });
        setAwaitingBackupEmailVerification(true);
        setNotice(`A one-time verification code was sent to ${result.masked}.`);
        return;
      }
      if (action === "remove_backup_email") {
        await requestJson("/api/account/two-factor/recovery-email", {
          method: "DELETE",
          body: JSON.stringify({ confirmation: "REMOVE BACKUP EMAIL" }),
        });
        setAction(null);
        await loadStatus();
        return;
      }
      await requestJson("/api/account/two-factor/factor", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DISABLE TWO-FACTOR AUTHENTICATION" }),
      });
      setAction(null);
      setRecoveryMethod(null);
      setAcknowledged(false);
      await loadStatus();
    });

  const confirmEmail = () =>
    run(async () => {
      await requestJson("/api/account/two-factor/recovery-email", {
        method: "PATCH",
        body: JSON.stringify({ token: emailToken }),
      });
      setEmailToken("");
      setAwaitingBackupEmailVerification(false);
      setBackupEmail("");
      setAction(null);
      setNotice("Backup email verified.");
      await loadStatus();
    });

  const requestEmailRecovery = () =>
    run(async () => {
      await requestJson("/api/account/two-factor/email-recovery", {
        method: "POST",
        body: "{}",
        headers: turnstileToken
          ? { [TURNSTILE_TOKEN_HEADER]: turnstileToken }
          : undefined,
      });
      setTurnstileToken(null);
      setTurnstileResetKey((value) => value + 1);
      setNotice("If the verified backup address is available, a one-time recovery code was sent.");
    });

  if (loading) {
    return (
      <div aria-busy="true" className="rounded-xl border border-white/10 bg-black/30 p-5">
        <p className="text-sm text-white/65" role="status">Loading two-factor settings…</p>
      </div>
    );
  }
  if (!status && loadErrorCode === "NOT_AUTHENTICATED") {
    return (
      <section className="rounded-2xl border border-orange-300/25 bg-orange-950/15 p-5 sm:p-6" aria-labelledby="security-sign-in-title">
        <h3 id="security-sign-in-title" className="text-lg font-semibold text-orange-100">
          Sign in to manage account security
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          Sponsor analytics remains available without an account. Authenticator,
          recovery-code, and backup-email settings require your existing Discord
          login and an active CancerCulture website session.
        </p>
        <a
          href="/api/auth/discord/login?state=/settings/security"
          className={`${buttonClass} mt-5 inline-flex items-center`}
        >
          Login with Discord
        </a>
      </section>
    );
  }
  if (!status) {
    return <p className="rounded-lg border border-red-300/25 bg-red-950/30 p-4 text-sm text-red-200" role="alert">{error}</p>;
  }

  return (
    <div className="space-y-6" aria-busy={busy}>
      {error ? <p className="rounded-lg border border-red-300/25 bg-red-950/30 p-3 text-sm text-red-200" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-orange-300/25 bg-orange-950/20 p-3 text-sm text-orange-100" role="status">{notice}</p> : null}

      {recoveryCodes ? (
        <section className="rounded-xl border border-orange-300/40 bg-orange-950/20 p-4" aria-labelledby="recovery-codes-title">
          <h3 id="recovery-codes-title" className="font-semibold text-orange-200">Save these recovery codes now</h3>
          <p className="mt-2 text-sm leading-relaxed text-white/70">This is the only time these codes are shown. Each code works once. Replacing them invalidates every older code immediately.</p>
          <ul className="mt-4 grid gap-2 font-mono text-sm sm:grid-cols-2">
            {recoveryCodes.map((code) => <li key={code} className="rounded bg-black/50 px-3 py-2">{code}</li>)}
          </ul>
          <label className="mt-4 flex gap-3 text-sm text-white/80">
            <input type="checkbox" checked={codesSaved} onChange={(event) => setCodesSaved(event.target.checked)} />
            I saved the codes in a secure place.
          </label>
          <button type="button" disabled={!codesSaved} onClick={() => setRecoveryCodes(null)} className={`${buttonClass} mt-4`}>Hide codes permanently</button>
        </section>
      ) : null}

      {enrollment ? (
        <section className="rounded-xl border border-white/10 bg-black/30 p-4">
          <h3 className="font-semibold">Activate the new authenticator</h3>
          <p className="mt-2 text-sm text-white/65">Scan this QR code with Google Authenticator or another standard TOTP app. It is shown only for this pending enrollment.</p>
          {/* This data URL is generated locally from the one-time otpauth contract. */}
          <Image
            src={enrollment.qrCodeDataUrl}
            alt="Authenticator enrollment QR code"
            width={288}
            height={288}
            unoptimized
            className="mx-auto mt-4 h-72 w-72 rounded bg-white p-2"
          />
          <details className="mt-3 text-sm text-white/70">
            <summary className="cursor-pointer">Cannot scan the QR code?</summary>
            <p className="mt-2 break-all font-mono text-white">{enrollment.manualKey}</p>
          </details>
          <label className="mt-4 block text-sm font-semibold" htmlFor="totp-activation-code">Current six-digit code</label>
          <input id="totp-activation-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={activationCode} onChange={(event) => setActivationCode(event.target.value)} className={`${inputClass} mt-2`} />
          <button type="button" disabled={busy || activationCode.trim().length < 6} onClick={activate} className={`${buttonClass} mt-3`}>Activate two-factor authentication</button>
        </section>
      ) : !status.active ? (
        <section className="rounded-xl border border-white/10 bg-black/30 p-4">
          <p className="text-sm leading-relaxed text-white/70">Add a Google-Authenticator-compatible time-based code as a step-up factor for sensitive account changes. Your Discord website login remains unchanged.</p>
          <div className="mt-4 rounded-lg border border-red-300/25 bg-red-950/25 p-3 text-sm leading-relaxed text-red-100">
            If you later lose your authenticator, all recovery codes, and have not verified a backup email, CancerCulture support and administrators cannot restore or bypass this factor.
          </div>
          <label className="mt-4 flex gap-3 text-sm text-white/80">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            I understand and accept responsibility for keeping recovery access.
          </label>
          <button type="button" disabled={!acknowledged || busy} onClick={() => void beginEnrollment("initial")} className={`${buttonClass} mt-4`}>Set up authenticator</button>
        </section>
      ) : (
        <>
          <section className="rounded-xl border border-emerald-300/20 bg-emerald-950/15 p-4">
            <p className="font-semibold text-emerald-200">Two-factor authentication is active</p>
            <p className="mt-2 text-sm text-white/70">Unused recovery codes: {status.recoveryCodesRemaining} of 10</p>
            <p className="mt-1 text-sm text-white/70">Backup email: {status.recoveryEmail?.masked ?? "Not configured"}</p>
          </section>

          <section className="rounded-2xl border border-orange-300/35 bg-orange-950/20 p-5 sm:p-6" aria-labelledby="lost-authenticator-title">
            <h3 id="lost-authenticator-title" className="text-xl font-semibold text-orange-100">
              Lost your authenticator?
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-white/75">
              Stay signed in with Discord and choose one of the recovery paths
              below. Both paths finish by setting up a new authenticator.
            </p>
            <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4 text-sm leading-relaxed text-white/70">
              Recovery codes are entered directly on this CancerCulture page,
              never in Google Authenticator. Each code works only once. A code
              does not replace Discord login or your website session, and it is
              not accepted in the Team Area verification field.
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <h4 className="font-semibold text-white">Use a recovery code</h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">
                  Enter one unused code here to authorize factor replacement,
                  then scan the new QR code and activate the new authenticator.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setRecoveryMethod("recovery_code");
                    setAction("replace_factor");
                  }}
                  className={`${buttonClass} mt-4 w-full`}
                >
                  Use a recovery code
                </button>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <h4 className="font-semibold text-white">Use verified backup email</h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">
                  {status.recoveryEmail
                    ? `Request a one-time recovery email at ${status.recoveryEmail.masked}. No QR code or recovery-code set is sent by email.`
                    : "No verified backup email is configured. This path cannot be used."}
                </p>
                <button
                  type="button"
                  disabled={!status.recoveryEmail}
                  onClick={() => {
                    setAction(null);
                    setRecoveryMethod("backup_email");
                    setAcknowledged(false);
                  }}
                  className={`${buttonClass} mt-4 w-full`}
                >
                  Use backup email
                </button>
              </div>
            </div>

            {recoveryMethod === "backup_email" && status.recoveryEmail ? (
              <div className="mt-5 rounded-xl border border-orange-300/25 bg-black/35 p-4 sm:p-5">
                <h4 ref={emailRecoveryHeadingRef} tabIndex={-1} className="font-semibold outline-none">
                  Recover with your verified backup email
                </h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">
                  The one-time email code works only in this signed-in
                  CancerCulture account. Redeeming it starts a pending replacement;
                  you must still activate the new factor with a real TOTP code.
                </p>
                {status.recoveryTurnstileSiteKey ? (
                  <div className="mt-4">
                    <TurnstileWidget action={TURNSTILE_ACTIONS.twoFactorRecovery} siteKey={status.recoveryTurnstileSiteKey} resetKey={turnstileResetKey} onTokenChange={setTurnstileToken} />
                  </div>
                ) : <p className="mt-3 text-sm text-red-200" role="alert">Email recovery is unavailable until Turnstile is configured.</p>}
                <button type="button" disabled={busy || !turnstileToken} onClick={requestEmailRecovery} className={`${buttonClass} mt-4`}>
                  {busy ? "Working…" : "Send one-time recovery email"}
                </button>
                <label htmlFor="email-recovery-code" className="mt-5 block text-sm font-semibold text-white/85">
                  One-time email recovery code
                </label>
                <input id="email-recovery-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={recoveryToken} onChange={(event) => setRecoveryToken(event.target.value)} className={`${inputClass} mt-2 font-mono`} />
                <label className="mt-4 flex gap-3 text-sm text-white/80">
                  <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                  I understand that activating the replacement invalidates the old factor and recovery codes.
                </label>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button type="button" disabled={busy || !acknowledged || recoveryToken.trim().length < 20} onClick={() => void beginEnrollment("email_recovery")} className={buttonClass}>Start new authenticator setup</button>
                  <button type="button" disabled={busy} onClick={() => { setRecoveryMethod(null); setRecoveryToken(""); setTurnstileToken(null); setAcknowledged(false); }} className={buttonClass}>Cancel email recovery</button>
                </div>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="manage-two-factor-title">
            <h3 id="manage-two-factor-title" className="text-xl font-semibold text-white">
              Manage two-factor authentication
            </h3>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <h4 className="font-semibold">Authenticator</h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">Move 2FA to a new authenticator while you still have a current authenticator or recovery code.</p>
                <button type="button" onClick={() => { setRecoveryMethod(null); setAction("replace_factor"); }} className={`${buttonClass} mt-4 w-full`}>Change authenticator</button>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                <h4 className="font-semibold">Recovery codes</h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">Create a fresh set of ten one-time codes. Every code from the previous set becomes invalid immediately.</p>
                <button type="button" onClick={() => { setRecoveryMethod(null); setAction("replace_codes"); }} className={`${buttonClass} mt-4 w-full`}>Replace recovery codes</button>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-4 md:col-span-2">
                <h4 className="font-semibold">Verified backup email</h4>
                <p className="mt-2 text-sm leading-relaxed text-white/65">Add or change the optional automated recovery path. Backup-email changes require a current authenticator code; recovery codes are not accepted.</p>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button type="button" onClick={() => { setRecoveryMethod(null); setAwaitingBackupEmailVerification(false); setAction("backup_email"); }} className={buttonClass}>{status.recoveryEmail ? "Change backup email" : "Add backup email"}</button>
                  {status.recoveryEmail ? <button type="button" onClick={() => { setRecoveryMethod(null); setAction("remove_backup_email"); }} className={buttonClass}>Remove backup email</button> : null}
                </div>
              </div>
            </div>
          </section>

          {action ? (
            <section className="rounded-xl border border-orange-300/25 bg-black/35 p-4 sm:p-5">
              <h3 ref={actionHeadingRef} tabIndex={-1} className="font-semibold outline-none">
                {action === "replace_factor" ? recoveryMethod === "recovery_code" ? "Use a recovery code to replace your authenticator" : "Change authenticator" : action === "replace_codes" ? "Replace all recovery codes" : action === "backup_email" ? "Verify a backup email" : action === "remove_backup_email" ? "Remove backup email" : "Disable two-factor authentication"}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/65">
                {action === "replace_codes" ? "All existing recovery codes become invalid immediately after this action." : action === "deactivate" ? "This removes the authenticator, recovery codes, backup email, and other active step-up grants. Other website sessions are revoked." : action === "remove_backup_email" ? "This permanently removes the automatic email recovery path. A current authenticator code is required; a recovery code is not accepted." : action === "replace_factor" ? recoveryMethod === "recovery_code" ? "Enter one unused recovery code directly below. It works once, does not replace Discord login, and only authorizes the next step: activating a new authenticator." : "Activating the new authenticator invalidates the current factor and every current recovery code." : "Enter a current authenticator code. A recovery code is not accepted for changing the backup email."}
              </p>
              {action === "backup_email" ? (
                <>
                  <label htmlFor="backup-email-address" className="mt-4 block text-sm font-semibold text-white/85">Backup email address</label>
                  <input id="backup-email-address" type="email" autoComplete="email" value={backupEmail} onChange={(event) => setBackupEmail(event.target.value)} className={`${inputClass} mt-2`} />
                </>
              ) : null}
              <label htmlFor="two-factor-step-up-code" className="mt-4 block text-sm font-semibold text-white/85">
                {action === "backup_email" || action === "remove_backup_email" ? "Current authenticator code" : recoveryMethod === "recovery_code" ? "Unused CancerCulture recovery code" : "Authenticator or recovery code"}
              </label>
              <input id="two-factor-step-up-code" inputMode={action === "backup_email" || action === "remove_backup_email" ? "numeric" : "text"} autoCapitalize="characters" autoComplete="one-time-code" value={stepUpCode} onChange={(event) => setStepUpCode(event.target.value)} className={`${inputClass} mt-2`} />
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button type="button" disabled={busy || stepUpCode.trim().length < 6 || (action === "backup_email" && !backupEmail.trim())} onClick={verifyForAction} className={buttonClass}>{busy ? "Working…" : "Verify and continue"}</button>
                <button type="button" disabled={busy} onClick={() => { setAction(null); setRecoveryMethod(null); setAwaitingBackupEmailVerification(false); }} className={buttonClass}>Cancel</button>
              </div>
              {action === "backup_email" && awaitingBackupEmailVerification ? (
                <div className="mt-4">
                  <label htmlFor="backup-email-verification-code" className="block text-sm font-semibold text-white/85">8-digit email verification code</label>
                  <input id="backup-email-verification-code" inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={emailToken} onChange={(event) => setEmailToken(event.target.value)} className={`${inputClass} mt-2`} />
                  <button type="button" disabled={busy || emailToken.replace(/[\s-]/gu, "").length !== 8} onClick={confirmEmail} className={`${buttonClass} mt-2`}>Verify backup email</button>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-xl border border-red-300/20 bg-red-950/15 p-4 sm:p-5" aria-labelledby="disable-two-factor-title">
            <h3 id="disable-two-factor-title" className="font-semibold text-red-100">Turn off two-factor authentication</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/65">Disabling 2FA removes the authenticator, recovery codes, backup email, and active step-up access. Team Area access remains unavailable until 2FA is active again.</p>
            <button type="button" onClick={() => { setRecoveryMethod(null); setAction("deactivate"); }} className={`${buttonClass} mt-4 border-red-300/30 text-red-100`}>Disable two-factor authentication</button>
          </section>
        </>
      )}
    </div>
  );
}
