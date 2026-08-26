import type { UserWarningAutoFlagCase } from "@/lib/admin/userFlagCases";

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function triggerLabel({
  triggeredByActiveCount,
  triggeredByFourteenDay,
}: Pick<
  UserWarningAutoFlagCase,
  "triggeredByActiveCount" | "triggeredByFourteenDay"
>) {
  if (triggeredByActiveCount && triggeredByFourteenDay) {
    return "Three active Warnings + active fourteen-day Warning";
  }
  if (triggeredByActiveCount) return "Three active Warnings";
  if (triggeredByFourteenDay) return "Active fourteen-day Warning";
  return "Thresholds cleared";
}

const eventLabels = {
  opened: "Opened",
  recomputed: "Recomputed",
  closed: "Closed",
} as const;

export default function AutomaticWarningFlagCaseCard({
  flagCase,
}: {
  flagCase: UserWarningAutoFlagCase;
}) {
  const latestThresholdSnapshot = [...flagCase.events]
    .reverse()
    .find((event) => event.eventType !== "closed");

  return (
    <article
      data-automatic-warning-flag
      className="rounded-xl border border-orange-300/35 bg-orange-500/[0.055] p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong>{flagCase.userDisplayName}</strong>
        <span className="rounded-full border border-orange-300/45 bg-orange-500/10 px-2.5 py-1 text-xs font-semibold text-orange-100">
          Automatic · Warning threshold
        </span>
        <span className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/75">
          {flagCase.status === "open" ? "Open" : "Closed"}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-white/50">Trigger</dt>
          <dd className="mt-1">
            {triggerLabel(latestThresholdSnapshot ?? flagCase)}
          </dd>
        </div>
        <div>
          <dt className="text-white/50">Active Warning count</dt>
          <dd className="mt-1">{flagCase.activeWarningCount}</dd>
        </div>
        <div>
          <dt className="text-white/50">Opened</dt>
          <dd className="mt-1">{formatTime(flagCase.openedAt)}</dd>
        </div>
        <div>
          <dt className="text-white/50">Closed</dt>
          <dd className="mt-1">{formatTime(flagCase.closedAt)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-white/55">
        Discord ID: {flagCase.discordUserId} · Generation {flagCase.generation} · Version {flagCase.rowVersion}
      </p>
      <p className="mt-3 text-sm text-white/65">
        Read-only automatic review signal. No manual close, Ban, Participation Hold, or other sanction is available here.
      </p>

      <details className="mt-4 rounded-lg border border-white/10 p-3">
        <summary className="cursor-pointer font-semibold">
          Automatic history ({flagCase.events.length})
        </summary>
        <ol className="mt-3 space-y-3 pl-5 text-sm">
          {flagCase.events.map((event) => (
            <li key={event.eventId}>
              <strong>{eventLabels[event.eventType]}</strong> · {formatTime(event.occurredAt)}
              <div className="mt-1 text-white/65">
                {triggerLabel(event)} · {event.activeWarningCount} active Warning(s) · case version {event.caseVersion}
              </div>
              <div className="mt-1 text-xs text-white/45">
                Recorded {formatTime(event.recordedAt)}
              </div>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}
