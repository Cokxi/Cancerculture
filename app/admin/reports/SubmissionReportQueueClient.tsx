"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SUBMISSION_REPORT_REASON_LABELS,
  type SubmissionReportReason,
} from "@/lib/reports/submissionReportContract";

type Item = Record<string, unknown>;
type Area = "live" | "finalized";

const DISPOSITIONS = [
  ["action_taken", "Action taken after review"],
  ["no_action_current_rules", "No action under current rules"],
  ["insufficient_information", "Insufficient information"],
  ["submission_unavailable", "Submission unavailable"],
  ["completed_other", "Completed - other"],
] as const;

function text(value: unknown, fallback = "-") {
  return typeof value === "string" && value ? value : fallback;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function items(value: unknown): Item[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Item =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function date(value: unknown) {
  return typeof value === "string"
    ? new Date(value).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      })
    : "-";
}

function reasonLabel(value: unknown) {
  const key = text(value, "") as SubmissionReportReason;
  return SUBMISSION_REPORT_REASON_LABELS[key] ?? text(value);
}

function statusLabel(value: unknown) {
  switch (value) {
    case "open":
      return "Open";
    case "in_review":
      return "In review";
    case "closed":
      return "Closed";
    default:
      return text(value);
  }
}

function ReportDetailModal({
  detail,
  onClose,
}: {
  detail: Item;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ) ?? []
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  const titleId = `report-detail-${text(detail.reportId, "unknown")}`;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close Report detail"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/80"
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/15 bg-neutral-950 p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300">
              Report detail
            </p>
            <h2 id={titleId} className="mt-2 text-2xl font-semibold">
              {reasonLabel(detail.reasonCode)}
            </h2>
            <p className="mt-1 text-xs text-white/50">
              {date(detail.createdAt)} UTC · {text(detail.phaseSnapshot)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-white/15 px-3 py-2 text-sm outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-orange-300"
          >
            Close
          </button>
        </div>

        {detail.subcategoryCode ? (
          <div className="mt-6 rounded-xl bg-white/[0.04] p-4">
            <div className="text-xs uppercase tracking-wide text-white/45">Detail</div>
            <div className="mt-1 text-white/85">{text(detail.subcategoryCode)}</div>
          </div>
        ) : null}
        <div className="mt-4 rounded-xl bg-white/[0.04] p-4">
          <div className="text-xs uppercase tracking-wide text-white/45">
            Reporter context
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-white/80">
            {text(detail.comment, "No additional context provided.")}
          </p>
        </div>
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-white/45">Reporter</dt>
            <dd className="mt-1">
              {typeof detail.reporterPublicProfileId === "string" ? (
                <Link
                  href={`/admin/reports/users/${detail.reporterPublicProfileId}`}
                  className="text-orange-300 underline underline-offset-4"
                >
                  {text(detail.reporterLabel, "Reporter")}
                </Link>
              ) : (
                text(detail.reporterLabel, "Anonymous reporter")
              )}
            </dd>
          </div>
          <div>
            <dt className="text-white/45">Visibility snapshot</dt>
            <dd className="mt-1">{text(detail.visibilitySnapshot)}</dd>
          </div>
        </dl>
        {detail.contentSha256 ? (
          <p className="mt-5 text-xs text-white/40">
            An evidence fingerprint was retained with this Report.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function WorkflowActions({
  reportCase,
  canReview,
  canOverrideRelease,
  onChanged,
}: {
  reportCase: Item;
  canReview: boolean;
  canOverrideRelease: boolean;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [disposition, setDisposition] = useState(DISPOSITIONS[0][0]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = text(reportCase.status, "") as "open" | "in_review" | "closed";
  const own = reportCase.isAssignedToViewer === true;

  async function mutate(
    operation:
      | "claim"
      | "release"
      | "forced_release"
      | "close"
  ) {
    const labels = {
      claim: "claim this Case",
      release: "return this Case to the open queue",
      forced_release: "release this Case through the Admin override",
      close: "close this Case",
    } as const;
    if (!window.confirm(`Confirm: ${labels[operation]}?`)) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/submission-reports/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId: reportCase.caseId,
          operation,
          expectedStatus: reportCase.status,
          expectedRowVersion: reportCase.rowVersion,
          expectedLatestReportId: reportCase.latestReportId,
          targetDiscordUserId: null,
          disposition: operation === "close" ? disposition : null,
          note: ["forced_release", "close"].includes(operation)
            ? note.trim()
            : null,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? "This Case changed. Its current state is being reloaded."
            : `Workflow action failed (${text(body?.error, "unknown error")}).`
        );
        await onChanged();
        return;
      }
      setNote("");
      setMessage("Case updated.");
      await onChanged();
    } finally {
      setPending(false);
    }
  }

  if (
    !canReview ||
    status === "closed" ||
    (status === "in_review" && !own && !canOverrideRelease)
  ) return null;
  const noteLength = note.trim().length;
  const optionalCloseNoteReady =
    noteLength === 0 || (noteLength >= 10 && noteLength <= 1000);
  const requiredOverrideNoteReady = noteLength >= 10 && noteLength <= 1000;

  return (
    <section className="mt-5 rounded-xl border border-orange-300/20 bg-orange-500/[0.05] p-4">
      <h4 className="font-semibold">Case workflow</h4>
      {status === "in_review" ? (
        <label className="mt-4 block text-sm">
          {own
            ? "Close note (optional)"
            : "Required Admin override reason"}
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={1000}
            rows={3}
            placeholder={own
              ? "Optional review context (10–1000 characters if provided)."
              : "Explain why the Admin override is required (10–1000 characters)."}
            className="mt-2 w-full rounded-lg border border-white/15 bg-black/40 p-3 outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
          />
          <span className="mt-1 block text-xs text-white/45">
            {note.trim().length}/1000 characters
          </span>
        </label>
      ) : null}
      {own && status === "in_review" ? (
        <label className="mt-3 block text-sm">
          Close outcome
          <select
            value={disposition}
            onChange={(event) =>
              setDisposition(event.target.value as typeof disposition)
            }
            className="mt-2 w-full rounded-lg border border-white/15 bg-neutral-950 p-3"
          >
            {DISPOSITIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {status === "open" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void mutate("claim")}
            className="cursor-pointer rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            Claim Case
          </button>
        ) : null}
        {status === "in_review" && own ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => void mutate("release")}
              className="cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Return to queue
            </button>
            <button
              type="button"
              disabled={pending || !optionalCloseNoteReady}
              onClick={() => void mutate("close")}
              className="cursor-pointer rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            >
              Close Case
            </button>
          </>
        ) : null}
        {status === "in_review" && canOverrideRelease && !own ? (
          <button
            type="button"
            disabled={pending || !requiredOverrideNoteReady}
            onClick={() => void mutate("forced_release")}
            className="cursor-pointer rounded-full border border-red-300/40 px-4 py-2 text-sm text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Admin override release
          </button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className="mt-3 text-sm text-white/75">
          {message}
        </p>
      ) : null}
    </section>
  );
}

export default function SubmissionReportQueueClient({
  area,
  initialCases,
  canReview,
  canOverrideRelease,
  initialCaseId,
}: {
  area: Area;
  initialCases: readonly Item[];
  canReview: boolean;
  canOverrideRelease: boolean;
  initialCaseId?: string;
}) {
  const router = useRouter();
  const [caseRows, setCaseRows] = useState<Item[]>([...initialCases]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summaries, setSummaries] = useState<Record<string, Item>>({});
  const [loadingCase, setLoadingCase] = useState<string | null>(null);
  const [detail, setDetail] = useState<Item | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const initialCaseOpened = useRef(false);

  const refreshSummary = useCallback(async (caseId: string) => {
    setLoadingCase(caseId);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/submission-reports/cases/${caseId}`,
        { cache: "no-store" }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.case) {
        setMessage("Case details could not be loaded.");
        return;
      }
      setSummaries((current) => ({ ...current, [caseId]: body.case }));
      setCaseRows((current) =>
        current.map((row) =>
          text(row.caseId, "") === caseId
            ? {
                ...row,
                status: body.case.status,
                rowVersion: body.case.rowVersion,
                latestReportId: body.case.latestReportId,
                assignedToDisplayName: body.case.assignedToDisplayName,
                assignedAt: body.case.assignedAt,
                isAssignedToViewer: body.case.isAssignedToViewer,
                assigneeEligible: body.case.assigneeEligible,
              }
            : row
        )
      );
      router.refresh();
    } finally {
      setLoadingCase(null);
    }
  }, [router]);

  const openCase = useCallback(async (caseId: string) => {
    if (expanded.has(caseId)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(caseId);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(caseId));
    if (!summaries[caseId]) await refreshSummary(caseId);
  }, [expanded, refreshSummary, summaries]);

  useEffect(() => {
    if (initialCaseId && !initialCaseOpened.current) {
      initialCaseOpened.current = true;
      void openCase(initialCaseId);
    }
  }, [initialCaseId, openCase]);

  async function openReport(caseId: string, reportId: string) {
    const wasUnread = items(summaries[caseId]?.reports).some(
      (report) => report.reportId === reportId && report.isRead !== true
    );
    setDetailLoading(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/submission-reports/reports/${reportId}`,
        { cache: "no-store" }
      );
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object") {
        setMessage("Report detail could not be loaded.");
        return;
      }
      setDetail(body);
      setSummaries((current) => {
        const summary = current[caseId];
        if (!summary) return current;
        return {
          ...current,
          [caseId]: {
            ...summary,
            reports: items(summary.reports).map((report) =>
              report.reportId === reportId ? { ...report, isRead: true } : report
            ),
          },
        };
      });
      if (wasUnread) setCaseRows((current) =>
        current.map((row) =>
          row.caseId === caseId
            ? {
                ...row,
                unreadReportCount: Math.max(0, number(row.unreadReportCount) - 1),
              }
            : row
        )
      );
      router.refresh();
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <>
      {message ? (
        <p role="status" className="rounded-xl border border-red-300/20 bg-red-500/10 p-4 text-sm text-red-100">
          {message}
        </p>
      ) : null}
      {caseRows.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-white/60">
          No {area === "live" ? "Live Cycle" : "Finalized Cycle"} Report Cases are available.
        </div>
      ) : (
        <div className="space-y-4">
          {caseRows.map((row) => {
            const caseId = text(row.caseId, "");
            const summary = summaries[caseId];
            const isExpanded = expanded.has(caseId);
            const unread = number(row.unreadReportCount);
            return (
              <article
                key={caseId}
                className="overflow-hidden rounded-2xl border border-white/10 bg-black/40"
              >
                <div className="grid gap-5 p-5 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <div>
                    {typeof row.thumbnailUrl === "string" ? (
                      <Link
                        href={text(row.destinationHref, "#")}
                        aria-label={`Open current view of submission #${number(row.submissionId)}`}
                        className="block h-36 overflow-hidden rounded-xl border border-white/15 outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                      >
                        <Image
                          src={row.thumbnailUrl}
                          alt={`Submission #${number(row.submissionId)} preview`}
                          width={400}
                          height={240}
                          unoptimized
                          className="h-full w-full object-cover transition-transform hover:scale-105"
                        />
                      </Link>
                    ) : (
                      <div className="flex h-36 items-center justify-center rounded-xl border border-white/10 bg-white/[0.02] px-3 text-center text-xs text-white/40">
                        Current public preview unavailable
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className="rounded-full bg-white/10 px-2 py-1 text-white/70">
                            {statusLabel(row.status)}
                          </span>
                          {unread > 0 ? (
                            <span className="rounded-full bg-red-500/20 px-2 py-1 font-semibold text-red-200">
                              {unread} new {unread === 1 ? "Report" : "Reports"}
                            </span>
                          ) : (
                            <span className="rounded-full bg-white/[0.06] px-2 py-1 text-white/45">
                              All Reports read
                            </span>
                          )}
                        </div>
                        <h2 className="mt-3 text-xl font-semibold">
                          Submission #{number(row.submissionId)}
                        </h2>
                        <p className="mt-1 text-sm text-white/55">
                          Cycle #{number(row.cycleId)} · {number(row.reportCount)} {number(row.reportCount) === 1 ? "Report" : "Reports"} · latest {date(row.latestReportAt)} UTC
                        </p>
                        <p className="mt-2 text-sm text-white/65">
                          {row.assignedToDisplayName
                            ? `Assigned to ${text(row.assignedToDisplayName)}`
                            : "Unassigned"}
                          {row.assigneeEligible === false ? " · assignee no longer eligible" : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-controls={`report-case-${caseId}`}
                        onClick={() => void openCase(caseId)}
                        className="cursor-pointer rounded-full bg-orange-500 px-4 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
                      >
                        {isExpanded ? "Close Case details" : "Open Case details"}
                      </button>
                    </div>
                  </div>
                </div>

                {isExpanded ? (
                  <div
                    id={`report-case-${caseId}`}
                    className="border-t border-white/10 bg-white/[0.02] p-5"
                  >
                    {loadingCase === caseId && !summary ? (
                      <p role="status" className="text-sm text-white/55">Loading Case details…</p>
                    ) : summary ? (
                      <div className="space-y-6">
                        <div className="grid gap-3 text-sm sm:grid-cols-3">
                          <div className="rounded-xl bg-black/30 p-4">
                            <div className="text-white/45">Uploader</div>
                            <div className="mt-1 font-medium">{text(summary.uploaderLabel)}</div>
                          </div>
                          <div className="rounded-xl bg-black/30 p-4">
                            <div className="text-white/45">Current votes</div>
                            <div className="mt-1 font-medium">{number(summary.currentVoteCount)}</div>
                          </div>
                          <div className="rounded-xl bg-black/30 p-4">
                            <div className="text-white/45">Current state</div>
                            <div className="mt-1 font-medium">
                              {summary.currentAvailable === true
                                ? text(summary.currentVisibility)
                                : "Submission unavailable"}
                            </div>
                          </div>
                        </div>

                        <section>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <h3 className="text-lg font-semibold">Reports</h3>
                            {typeof row.submissionActionHref === "string" &&
                            typeof row.submissionActionLabel === "string" ? (
                              <Link
                                href={row.submissionActionHref}
                                prefetch={false}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex cursor-pointer rounded-full border border-orange-300/50 px-4 py-2 text-sm font-semibold text-orange-100 outline-none transition hover:bg-orange-500/15 focus-visible:ring-2 focus-visible:ring-orange-300"
                              >
                                {row.submissionActionLabel}
                              </Link>
                            ) : null}
                          </div>
                          <div className="mt-3 space-y-2">
                            {items(summary.reports).map((report) => (
                              <div
                                key={text(report.reportId)}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-4"
                              >
                                <div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium text-orange-200">
                                      {reasonLabel(report.reasonCode)}
                                    </span>
                                    {report.isRead === true ? (
                                      <span className="text-xs text-white/40">Read</span>
                                    ) : (
                                      <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-semibold text-red-200">New</span>
                                    )}
                                  </div>
                                  <div className="mt-1 text-xs text-white/50">
                                    {date(report.createdAt)} UTC · {text(report.phaseSnapshot)}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  disabled={detailLoading}
                                  onClick={() => void openReport(caseId, text(report.reportId, ""))}
                                  className="cursor-pointer rounded-full border border-orange-300/40 px-4 py-2 text-sm text-orange-100 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  View Report
                                </button>
                              </div>
                            ))}
                          </div>
                        </section>

                        {summary.status === "closed" ? (
                          <section className="rounded-xl border border-emerald-300/20 bg-emerald-500/[0.06] p-5">
                            <h3 className="text-lg font-semibold">Completed review</h3>
                            <p className="mt-2 text-sm text-emerald-100">
                              {text(summary.closeDisposition)} · {date(summary.closedAt)} UTC
                            </p>
                          </section>
                        ) : null}

                        <WorkflowActions
                          reportCase={summary}
                          canReview={canReview}
                          canOverrideRelease={canOverrideRelease}
                          onChanged={() => refreshSummary(caseId)}
                        />

                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
      {detail ? (
        <ReportDetailModal detail={detail} onClose={() => setDetail(null)} />
      ) : null}
    </>
  );
}
