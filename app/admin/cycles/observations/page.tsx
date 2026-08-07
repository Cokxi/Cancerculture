import { requireAdminPage } from "@/lib/auth/pageAccess";
import {
  loadCycleVoteObservationReadModel,
  type SubmissionVoteObservation,
} from "@/lib/cycles/voteObservationReadModel";

export const dynamic = "force-dynamic";

const utcFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

function displayUtc(value: string | null) {
  return value ? `${utcFormatter.format(new Date(value))} UTC` : "—";
}

function displayShare(observation: SubmissionVoteObservation) {
  if (observation.cycleVotes === 0) {
    return "—";
  }

  return `${(
    (observation.totalVotes * 100) /
    observation.cycleVotes
  ).toFixed(1)}%`;
}

function statusLabel(status: string) {
  if (status === "ready") return "Ready";
  if (status === "failed") return "Technical retry needed";
  if (status === "calculating") return "Calculating";
  return "Pending";
}

export default async function CycleVoteObservationsPage() {
  await requireAdminPage("/admin/cycles/observations");
  const cycles = await loadCycleVoteObservationReadModel();

  return (
    <section className="mx-auto max-w-7xl space-y-7">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-300">
          Owner-only calibration
        </p>
        <h1 className="mt-2 text-2xl font-semibold">
          Cycle Vote Observations
        </h1>
        <p className="mt-3 max-w-4xl text-sm leading-6 text-white/65">
          Privacy-bounded aggregates from accepted votes in completed voting
          phases. This observation mode creates no fraud label, review marker,
          automatic moderation action, or finalization block.
        </p>
      </header>

      {cycles.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5 text-sm text-white/60">
          No observation snapshot exists yet. Future cycle attempts are bound
          when voting starts and queued when voting closes; historical test
          cycles are intentionally not backfilled.
        </div>
      ) : null}

      {cycles.map((cycle) => (
        <article
          key={`${cycle.cycleId}:${cycle.resetCount}`}
          className="rounded-xl border border-white/10 bg-white/[0.04] p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                Cycle #{cycle.cycleId}
                {cycle.cycleTitle ? ` · ${cycle.cycleTitle}` : ""}
              </h2>
              <p className="mt-1 text-xs text-white/50">
                Attempt {cycle.resetCount} · Policy v{cycle.policyVersion} · {" "}
                {statusLabel(cycle.status)}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center text-sm">
              <div className="rounded-lg bg-black/25 px-3 py-2">
                <div className="text-white/50">Votes</div>
                <div className="mt-1 font-semibold">
                  {cycle.voteCount ?? "—"}
                </div>
              </div>
              <div className="rounded-lg bg-black/25 px-3 py-2">
                <div className="text-white/50">Voters</div>
                <div className="mt-1 font-semibold">
                  {cycle.distinctVoterCount ?? "—"}
                </div>
              </div>
              <div className="rounded-lg bg-black/25 px-3 py-2">
                <div className="text-white/50">Submissions</div>
                <div className="mt-1 font-semibold">
                  {cycle.submissionCount ?? "—"}
                </div>
              </div>
            </div>
          </div>

          <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="text-white/45">Voting start</dt>
              <dd className="mt-1">{displayUtc(cycle.votingStartedAt)}</dd>
            </div>
            <div>
              <dt className="text-white/45">Voting end</dt>
              <dd className="mt-1">{displayUtc(cycle.votingEndedAt)}</dd>
            </div>
          </dl>

          {cycle.status === "failed" ? (
            <p className="mt-5 rounded-lg border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-100">
              Aggregate snapshot unavailable: {cycle.errorCode ?? "unknown"}.
              Reloading this Owner page retries the technical calculation. The
              cycle itself remains unaffected.
            </p>
          ) : null}

          {cycle.status !== "ready" ? (
            <p className="mt-5 text-sm text-white/55">
              Aggregate details are not ready yet. The observation state does
              not affect moderation or finalization.
            </p>
          ) : null}

          {cycle.status === "ready" && cycle.submissions.length === 0 ? (
            <p className="mt-5 text-sm text-white/55">
              This cycle had no submissions.
            </p>
          ) : null}

          {cycle.submissions.length > 0 ? (
            <div className="mt-6 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-white/10 text-xs uppercase tracking-wide text-white/45">
                  <tr>
                    <th className="px-3 py-2">Submission</th>
                    <th className="px-3 py-2">Votes / share</th>
                    <th className="px-3 py-2">Peak 5m</th>
                    <th className="px-3 py-2">Last 5 / 15 / 60m</th>
                    <th className="px-3 py-2">Non-empty buckets</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {cycle.submissions.map((submission) => (
                    <tr key={submission.submissionId}>
                      <td className="px-3 py-3 align-top">
                        <div className="font-medium">
                          #{submission.submissionId}
                        </div>
                        <div className="mt-1 text-xs text-white/45">
                          {submission.isDisqualified ? "Disqualified" : "Eligible"}
                          {` · ${submission.visibilityStatus}`}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        {submission.totalVotes} / {displayShare(submission)}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div>{submission.peak5mVotes}</div>
                        <div className="mt-1 text-xs text-white/45">
                          {displayUtc(submission.peak5mStartedAt)}
                        </div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        {submission.last5mVotes} / {submission.last15mVotes} / {" "}
                        {submission.last60mVotes}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {submission.buckets.length === 0
                          ? "—"
                          : submission.buckets
                              .map((bucket) => `#${bucket.index}: ${bucket.votes}`)
                              .join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
