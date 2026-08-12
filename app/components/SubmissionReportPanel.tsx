"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TurnstileWidget from "@/app/components/TurnstileWidget";
import {
  SUBMISSION_REPORT_COMMENT_MAX_LENGTH,
  SUBMISSION_REPORT_COMMENT_MIN_LENGTH,
  SUBMISSION_REPORT_REASON_LABELS,
  SUBMISSION_REPORT_REASONS_BY_SURFACE,
  SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH,
  SUBMISSION_REPORT_SUBCATEGORIES,
  SUBMISSION_REPORT_SUBCATEGORY_LABELS,
  submissionReportRequiresContext,
  type SubmissionReportReason,
  type SubmissionReportSurface,
} from "@/lib/reports/submissionReportContract";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import {
  POST_VOTING_REPORT_BLOCK_REASON,
  POST_VOTING_REPORT_CLOSED_TEXT,
} from "@/lib/cycles/postVoting";
import {
  createSubmissionReportIdempotencyKey,
  submitSubmissionReportFromClient,
} from "@/lib/reports/submissionReportClient";

type Eligibility = Readonly<{
  canReport: boolean;
  alreadyReported: boolean;
  hasMultipleExistingReports: boolean;
  blockedReason: typeof POST_VOTING_REPORT_BLOCK_REASON | null;
}>;

function errorMessage(code: string | null) {
  switch (code) {
    case "ALREADY_REPORTED":
      return "You already reported this submission.";
    case "SUBMISSION_NOT_REPORTABLE":
      return "This submission is no longer available for reporting.";
    case "REPORTING_CLOSED":
      return POST_VOTING_REPORT_CLOSED_TEXT;
    case "TURNSTILE_REQUIRED":
    case "TURNSTILE_INVALID":
      return "Verification expired or failed. Please verify again.";
    case "TURNSTILE_PROVIDER_UNAVAILABLE":
    case "TURNSTILE_CONFIGURATION_ERROR":
    case "REPORT_CONFIGURATION_UNAVAILABLE":
    case "REPORT_SERVICE_UNAVAILABLE":
      return "Reporting is temporarily unavailable. Please try again later.";
    case "IDEMPOTENCY_CONFLICT":
      return "The report changed after an earlier attempt. Review it and try again.";
    case "REPORT_NETWORK_ERROR":
      return "The report request did not reach the server. Check your connection or site blocking, then verify and try again.";
    case "REPORT_CLIENT_UNAVAILABLE":
      return "This browser could not securely start the report request. Reload the page and try again.";
    default:
      return "The report could not be submitted. Please try again.";
  }
}

export default function SubmissionReportPanel({
  isAuthenticated,
  loginReturnPath,
  submissionId,
  surface,
  reportingOpen,
  turnstileSiteKey,
}: {
  isAuthenticated: boolean;
  loginReturnPath: string;
  submissionId: number;
  surface: SubmissionReportSurface;
  reportingOpen: boolean;
  turnstileSiteKey: string | null;
}) {
  const reasons = SUBMISSION_REPORT_REASONS_BY_SURFACE[surface];
  const [expanded, setExpanded] = useState(false);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [eligibilityError, setEligibilityError] = useState<string | null>(null);
  const [loadingEligibility, setLoadingEligibility] = useState(false);
  const [step, setStep] = useState<"edit" | "review" | "success">("edit");
  const [reason, setReason] = useState<SubmissionReportReason>(reasons[0]);
  const [subcategory, setSubcategory] = useState("");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLParagraphElement>(null);

  const effectiveSubcategory =
    reason === "other_rules_concern" ? "other" : subcategory;
  const contextRequired =
    effectiveSubcategory.length > 0 &&
    submissionReportRequiresContext(reason, effectiveSubcategory);
  const trimmedCommentLength = comment.trim().length;
  const minimumContextLength = contextRequired
    ? SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH
    : SUBMISSION_REPORT_COMMENT_MIN_LENGTH;
  const contextValid = contextRequired
    ? trimmedCommentLength >= minimumContextLength
    : trimmedCommentLength === 0 ||
      trimmedCommentLength >= minimumContextLength;
  const editValid = effectiveSubcategory.length > 0 && contextValid;

  const contextLabel = useMemo(() => {
    if (contextRequired) {
      return `Additional context (required, at least ${SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH} characters)`;
    }
    return "Additional context (optional)";
  }, [contextRequired]);

  const resetAttempt = useCallback(() => {
    setIdempotencyKey(null);
    setTurnstileToken(null);
    setTurnstileResetKey((value) => value + 1);
    setSubmitError(null);
  }, []);

  useEffect(() => {
    setExpanded(false);
    setEligibility(null);
    setEligibilityError(null);
    setStep("edit");
    setReason(reasons[0]);
    setSubcategory("");
    setComment("");
    setConfirmed(false);
    resetAttempt();
  }, [reasons, resetAttempt, submissionId]);

  const loadEligibility = useCallback(async () => {
    if (!isAuthenticated) return;
    setLoadingEligibility(true);
    setEligibilityError(null);
    try {
      const response = await fetch(
        `/api/submission-reports/eligibility?submissionId=${submissionId}`,
        { cache: "no-store" }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "REPORT_SERVICE_UNAVAILABLE");
      }
      setEligibility(data as Eligibility);
    } catch (error) {
      setEligibilityError(
        errorMessage(error instanceof Error ? error.message : null)
      );
    } finally {
      setLoadingEligibility(false);
    }
  }, [isAuthenticated, submissionId]);

  useEffect(() => {
    if (
      !expanded ||
      !isAuthenticated ||
      !reportingOpen ||
      step === "success"
    ) {
      return;
    }

    const refreshEligibility = () => {
      if (document.visibilityState === "visible") {
        void loadEligibility();
      }
    };
    const intervalId = window.setInterval(refreshEligibility, 15_000);
    window.addEventListener("focus", refreshEligibility);
    document.addEventListener("visibilitychange", refreshEligibility);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshEligibility);
      document.removeEventListener("visibilitychange", refreshEligibility);
    };
  }, [expanded, isAuthenticated, loadEligibility, reportingOpen, step]);

  useEffect(() => {
    if (submitError) {
      submitErrorRef.current?.focus();
    }
  }, [submitError]);

  async function submitReport() {
    if (!confirmed || !turnstileToken || submitting || !editValid) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const requestId =
        idempotencyKey ?? createSubmissionReportIdempotencyKey();
      setIdempotencyKey(requestId);
      const { data, response } = await submitSubmissionReportFromClient(
        {
          submissionId,
          reason,
          subcategory: effectiveSubcategory,
          comment: comment.trim() || null,
          idempotencyKey: requestId,
        },
        turnstileToken,
      );
      if (!response.ok) {
        if (data?.error === "ALREADY_REPORTED") {
          setEligibility((current) => ({
            canReport: false,
            alreadyReported: true,
            hasMultipleExistingReports:
              current?.hasMultipleExistingReports ?? false,
            blockedReason: current?.blockedReason ?? null,
          }));
        }
        if (data?.error === "REPORTING_CLOSED") {
          setEligibility((current) => ({
            canReport: false,
            alreadyReported: current?.alreadyReported ?? false,
            hasMultipleExistingReports:
              current?.hasMultipleExistingReports ?? false,
            blockedReason: POST_VOTING_REPORT_BLOCK_REASON,
          }));
        }
        throw new Error(data?.error ?? "REPORT_FAILED");
      }

      setStep("success");
      setEligibility((current) => ({
        canReport: false,
        alreadyReported: true,
        hasMultipleExistingReports:
          current?.hasMultipleExistingReports ?? false,
        blockedReason: current?.blockedReason ?? null,
      }));
    } catch (error) {
      setSubmitError(
        errorMessage(error instanceof Error ? error.message : null)
      );
    } finally {
      setTurnstileToken(null);
      setTurnstileResetKey((value) => value + 1);
      setSubmitting(false);
    }
  }

  const reportingClosed =
    !reportingOpen ||
    eligibility?.blockedReason === POST_VOTING_REPORT_BLOCK_REASON;

  if (reportingClosed && step !== "success") {
    return (
      <p role="status" className="text-sm text-white/65">
        {POST_VOTING_REPORT_CLOSED_TEXT}
      </p>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 text-sm">
        <a
          href={`/api/auth/discord/login?state=${encodeURIComponent(loginReturnPath)}`}
          className="cursor-pointer text-orange-300 underline underline-offset-4"
        >
          Log in with Discord to report this submission
        </a>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
          if (!eligibility) void loadEligibility();
        }}
        className="cursor-pointer rounded-full border border-red-300/30 bg-red-500/10 px-4 py-2 text-sm text-red-200 transition hover:bg-red-500/20"
      >
        Report submission
      </button>
    );
  }

  return (
    <section
      aria-labelledby={`submission-report-${submissionId}`}
      className="rounded-xl border border-red-300/20 bg-red-500/[0.07] p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id={`submission-report-${submissionId}`}
            className="font-semibold text-red-100"
          >
            Report submission
          </h2>
          <p className="mt-1 text-xs text-white/60">
            A report asks the team to review the submission. It does not prove a
            rules violation.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="cursor-pointer text-xs text-white/60 underline underline-offset-4"
        >
          Close
        </button>
      </div>

      {/* Unmounting a verified Turnstile widget clears its single-use token. */}
      {loadingEligibility && !eligibility ? (
        <p role="status" className="mt-4 text-sm text-white/70">
          Checking availability…
        </p>
      ) : eligibilityError && !eligibility ? (
        <div className="mt-4 text-sm text-red-200">
          <p role="alert">{eligibilityError}</p>
          <button
            type="button"
            onClick={() => void loadEligibility()}
            className="mt-2 cursor-pointer underline"
          >
            Try again
          </button>
        </div>
      ) : step === "success" ? (
        <div role="status" className="mt-4 space-y-2 text-sm text-green-300">
          <p className="font-medium">Report received.</p>
          <p>
            Thank you for your engagement and for helping keep this project safe,
            fair, and welcoming.
          </p>
        </div>
      ) : eligibility?.alreadyReported ? (
        <p role="status" className="mt-4 text-sm text-orange-200">
          You already reported this submission.
        </p>
      ) : eligibility && !eligibility.canReport ? (
        <p role="status" className="mt-4 text-sm text-white/70">
          This submission is no longer available for reporting.
        </p>
      ) : eligibility ? (
        <div className="mt-4 space-y-4">
          {step === "edit" ? (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-white/80">Reason</span>
                <select
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value as SubmissionReportReason);
                    setSubcategory("");
                    resetAttempt();
                  }}
                  className="w-full cursor-pointer rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-white"
                >
                  {reasons.map((value) => (
                    <option key={value} value={value}>
                      {SUBMISSION_REPORT_REASON_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>

              {reason !== "other_rules_concern" ? (
                <label className="block text-sm">
                  <span className="mb-1 block text-white/80">
                    More detail (required)
                  </span>
                  <select
                    value={subcategory}
                    required
                    onChange={(event) => {
                      setSubcategory(event.target.value);
                      resetAttempt();
                    }}
                    className="w-full cursor-pointer rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-white"
                  >
                    <option value="" disabled>
                      Select a category
                    </option>
                    {SUBMISSION_REPORT_SUBCATEGORIES[reason].map((value) => (
                      <option key={value} value={value}>
                        {SUBMISSION_REPORT_SUBCATEGORY_LABELS[value] ?? value}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {reason === "fair_play_manipulation" ? (
                <p className="rounded-lg bg-orange-500/10 p-3 text-sm text-orange-100">
                  Explain where and how the submission was promoted or the vote was
                  influenced. If the team needs more information, it may contact you
                  through your connected Discord account.
                </p>
              ) : null}

              <label className="block text-sm">
                <span className="mb-1 block text-white/80">{contextLabel}</span>
                <textarea
                  rows={4}
                  maxLength={SUBMISSION_REPORT_COMMENT_MAX_LENGTH}
                  value={comment}
                  onChange={(event) => {
                    setComment(event.target.value);
                    resetAttempt();
                  }}
                  placeholder={
                    contextRequired
                      ? `Describe the concern in at least ${SUBMISSION_REPORT_REQUIRED_COMMENT_MIN_LENGTH} characters.`
                      : `Optional; if used, enter at least ${SUBMISSION_REPORT_COMMENT_MIN_LENGTH} characters.`
                  }
                  className="w-full rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-white"
                />
                <span
                  className={`mt-1 block text-right text-xs ${
                    contextValid ? "text-white/50" : "text-red-200"
                  }`}
                >
                  {comment.length}/{SUBMISSION_REPORT_COMMENT_MAX_LENGTH}
                </span>
              </label>

              <button
                type="button"
                disabled={!editValid}
                onClick={() => {
                  setStep("review");
                  setConfirmed(false);
                  resetAttempt();
                }}
                className="cursor-pointer rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Review report
              </button>
            </>
          ) : (
            <>
              {eligibility.hasMultipleExistingReports ? (
                <p className="rounded-lg bg-orange-500/10 p-3 text-sm text-orange-200">
                  This submission has already been reported multiple times. The
                  team can review it; you may still send your own first report.
                </p>
              ) : null}
              <dl className="space-y-2 rounded-lg bg-black/30 p-3 text-sm">
                <div>
                  <dt className="text-white/55">Reason</dt>
                  <dd>{SUBMISSION_REPORT_REASON_LABELS[reason]}</dd>
                </div>
                {reason !== "other_rules_concern" ? (
                  <div>
                    <dt className="text-white/55">Detail</dt>
                    <dd>
                      {SUBMISSION_REPORT_SUBCATEGORY_LABELS[
                        effectiveSubcategory
                      ]}
                    </dd>
                  </div>
                ) : null}
                {comment.trim() ? (
                  <div>
                    <dt className="text-white/55">Context</dt>
                    <dd className="whitespace-pre-wrap break-words">
                      {comment.trim()}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="rounded-lg border border-orange-300/20 bg-orange-500/10 p-3 text-sm text-orange-100">
                <p>
                  Good-faith reports are welcome. Knowingly false, retaliatory, or
                  mass reporting may lead to manually reviewed account warnings or
                  restrictions.
                </p>
              </div>
              <label className="flex cursor-pointer items-start gap-3 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="mt-1 cursor-pointer"
                />
                <span>
                  I have read the{" "}
                  <Link
                    href="/rules#report-system"
                    target="_blank"
                    className="cursor-pointer text-orange-300 underline underline-offset-4"
                  >
                    Rules
                  </Link>{" "}
                  and agree to use the report system in good faith.
                </span>
              </label>
              <TurnstileWidget
                action={TURNSTILE_ACTIONS.submissionReport}
                siteKey={turnstileSiteKey}
                resetKey={turnstileResetKey}
                onTokenChange={setTurnstileToken}
              />
              {submitError ? (
                <p
                  ref={submitErrorRef}
                  role="alert"
                  tabIndex={-1}
                  className="rounded-lg border border-red-300/30 bg-red-950/60 p-3 text-sm font-medium text-red-100 outline-none focus:ring-2 focus:ring-red-300/50"
                >
                  <span className="mb-1 block font-semibold">
                    Report not sent
                  </span>
                  {submitError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setStep("edit")}
                  className="cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!confirmed || !turnstileToken || submitting}
                  onClick={() => void submitReport()}
                  className="cursor-pointer rounded-full bg-red-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {submitting ? "Submitting…" : "Submit report"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
