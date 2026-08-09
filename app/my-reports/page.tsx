export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import {
  SUBMISSION_REPORT_REASON_LABELS,
  SUBMISSION_REPORT_SUBCATEGORY_LABELS,
  type SubmissionReportReason,
} from "@/lib/reports/submissionReportContract";
import { loadOwnSubmissionReports } from "@/lib/reports/submissionReportOwn.server";
import {
  isSubmissionReportOutcomeCode,
  SUBMISSION_REPORT_OUTCOME_LABELS,
} from "@/lib/reports/submissionReportOutcome";
import { getSubmissionDestinationHref } from "@/lib/submissions/getSubmissionDestinationHref";

const MY_REPORTS_PATH = "/my-reports";

function text(value: unknown, fallback = "-") {
  return typeof value === "string" && value ? value : fallback;
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function reasonLabel(value: unknown) {
  const reason = text(value, "") as SubmissionReportReason;
  return SUBMISSION_REPORT_REASON_LABELS[reason] ?? text(value);
}

function outcomeLabel(value: unknown) {
  return isSubmissionReportOutcomeCode(value)
    ? SUBMISSION_REPORT_OUTCOME_LABELS[value]
    : "Status unavailable";
}

export default async function MyReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sessionState = await getSessionState();

  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${MY_REPORTS_PATH}`);
  }
  if (sessionState.status === "restricted") {
    const code =
      sessionState.reason === "discord_banned"
        ? "DISCORD_BANNED"
        : "WEBSITE_BANNED";
    redirect(`/banned?code=${code}`);
  }
  if (sessionState.status === "dependency_unavailable") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 text-white">
        <BackButton href="/my-profile" label="My Profile" />
        <div
          className="mt-8 rounded-2xl border border-white/10 bg-black/70 p-8 text-center"
          role="status"
        >
          Your reports are temporarily unavailable.
        </div>
      </main>
    );
  }

  const params = await searchParams;
  let page: Awaited<ReturnType<typeof loadOwnSubmissionReports>>;
  try {
    page = await loadOwnSubmissionReports({
      cursor: params.after ?? null,
      discordUserId: sessionState.session.discord_user_id,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      error.status === 400
    ) {
      redirect(MY_REPORTS_PATH);
    }
    throw error;
  }
  const reports = page.items;

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 text-white">
      <BackButton href="/my-profile" label="My Profile" />

      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          My Reports
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-gray-300">
          This private view shows only reports sent by your account and a
          privacy-safe case outcome. An action shown here means the case led to
          an action after review; it does not claim that your individual report
          caused it.
        </p>
      </header>

      {reports.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-black/40 p-8 text-center text-sm text-white/60">
          You have not submitted any reports.
        </div>
      ) : (
        <div className="space-y-4">
          {reports.map((report) => {
            const submissionId = number(report.submissionId);
            const cycleId = number(report.cycleId);
            const destination =
              report.currentAvailable === true
                ? getSubmissionDestinationHref({
                    cycleId,
                    cycleStatus: text(report.currentCycleStatus, ""),
                    isDisqualified: report.currentDisqualified === true,
                    publicVisibilityStatus: text(
                      report.currentVisibility,
                      ""
                    ),
                    submissionId,
                  })
                : null;
            const subcategory = text(report.subcategoryCode, "");

            return (
              <article
                key={text(report.reportId)}
                className="rounded-2xl border border-white/10 bg-black/40 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-orange-200">
                      {reasonLabel(report.reasonCode)}
                    </h2>
                    <p className="mt-1 text-xs text-white/55">
                      Submission #{submissionId} · Cycle #{cycleId} ·{" "}
                      {text(report.phaseSnapshot)} · {text(report.createdAt)}
                    </p>
                  </div>
                  <span className="rounded-full bg-orange-500/15 px-3 py-1 text-xs text-orange-100">
                    {outcomeLabel(report.outcomeCode)}
                  </span>
                </div>

                <dl className="mt-4 space-y-2 text-sm">
                  <div>
                    <dt className="text-white/50">Detail</dt>
                    <dd>
                      {(SUBMISSION_REPORT_SUBCATEGORY_LABELS[subcategory] ??
                        subcategory) || "Not recorded"}
                    </dd>
                  </div>
                  {report.comment ? (
                    <div>
                      <dt className="text-white/50">Your context</dt>
                      <dd className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-white/[0.04] p-3 text-white/75">
                        {text(report.comment)}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {destination ? (
                  <Link
                    href={destination}
                    className="mt-4 inline-flex cursor-pointer text-sm text-orange-300 underline underline-offset-4"
                  >
                    Open submission
                  </Link>
                ) : (
                  <p className="mt-4 text-xs text-white/45">
                    The submission is not currently available on a public
                    surface.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {page.nextCursor ? (
        <div className="flex justify-center">
          <Link
            href={`${MY_REPORTS_PATH}?after=${encodeURIComponent(page.nextCursor)}`}
            className="cursor-pointer rounded-full border border-[var(--orange-dark)]/50 px-5 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
          >
            View older reports
          </Link>
        </div>
      ) : null}
    </main>
  );
}
