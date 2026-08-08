import Link from "next/link";
import { redirect } from "next/navigation";
import UserProfileLink from "../shared/UserProfileLink";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  loadVoteRefundHistoryReadModel,
  VOTE_REFUND_HISTORY_PAGE_SIZE,
  type VoteRefundHistoryEntry,
} from "@/lib/voteRefund/historyReadModel.server";

export const dynamic = "force-dynamic";

function pageHref(page: number) {
  return page > 1
    ? `/admin/logs/vote-refunds?page=${page}`
    : "/admin/logs/vote-refunds";
}

function RefundCard({
  entry,
  isAdmin,
}: {
  entry: VoteRefundHistoryEntry;
  isAdmin: boolean;
}) {
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {entry.refundedVoteCount} vote
            {entry.refundedVoteCount === 1 ? "" : "s"} refunded
          </h2>
          <p className="mt-1 text-xs text-white/45">
            {new Date(entry.occurredAt).toLocaleString()}
          </p>
        </div>
        <span className="rounded border border-white/15 px-2 py-0.5 text-xs text-white/65">
          Cycle {entry.cycleId} · attempt {entry.resetCount}
        </span>
      </div>

      <dl className="mt-4 grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-white/40">Actor</dt>
        <dd className="min-w-0">
          <UserProfileLink
            discordUserId={entry.actorDiscordUserId}
            label={entry.actorLabel ?? entry.actorDiscordUserId}
            publicProfileId={entry.actorPublicProfileId}
          />
        </dd>
        <dt className="text-white/40">Affected voters</dt>
        <dd>{entry.affectedVoterCount}</dd>
        <dt className="text-white/40">Votes per user</dt>
        <dd>{entry.votesPerUser}</dd>
        <dt className="text-white/40">Reason category</dt>
        <dd>Confirmed disqualification</dd>
      </dl>

      <div className="mt-4 border-t border-white/10 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-white/40">
          Explicitly selected submissions
        </p>
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {entry.submissionRefunds.map((submission) => (
            <li
              key={submission.submissionId}
              className="rounded border border-white/10 px-2 py-1 text-white/65"
            >
              #{submission.submissionId}: {submission.refundedVoteCount} vote
              {submission.refundedVoteCount === 1 ? "" : "s"}
            </li>
          ))}
        </ul>
      </div>

      {isAdmin && entry.adminAudit ? (
        <details className="mt-4 border-t border-white/10 pt-4">
          <summary className="cursor-pointer text-xs font-semibold text-white/55">
            Owner-only audit context
          </summary>
          <dl className="mt-3 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-white/40">Reason</dt>
            <dd className="break-words text-white/70">
              {entry.adminAudit.reasonText}
            </dd>
            <dt className="text-white/40">Actor role</dt>
            <dd>{entry.adminAudit.actorRole}</dd>
            <dt className="text-white/40">Capability</dt>
            <dd>{entry.adminAudit.requiredCapability}</dd>
            <dt className="text-white/40">Request hash</dt>
            <dd className="break-all font-mono text-white/55">
              {entry.adminAudit.requestHash}
            </dd>
          </dl>
        </details>
      ) : null}
    </article>
  );
}

export default async function VoteRefundHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const parsedPage = Number.parseInt(params.page ?? "1", 10);
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;
  let readModel;

  try {
    readModel = await loadVoteRefundHistoryReadModel({ page });
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const hasNextPage = readModel.page * readModel.pageSize < readModel.total;

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          {readModel.isAdmin
            ? "Owner audit · Read-only"
            : "Delegated audit · Read-only"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Vote Refund History
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Append-only history of successful selective refunds. Individual voter
          records are not exposed on this surface.
        </p>
      </header>

      {readModel.entries.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
          No vote refunds have been recorded.
        </p>
      ) : (
        <div className="grid gap-3">
          {readModel.entries.map((entry) => (
            <RefundCard key={entry.id} entry={entry} isAdmin={readModel.isAdmin} />
          ))}
        </div>
      )}

      {readModel.total > VOTE_REFUND_HISTORY_PAGE_SIZE ? (
        <nav aria-label="Vote Refund History pages" className="mt-5 flex gap-4 text-sm">
          {readModel.page > 1 ? (
            <Link href={pageHref(readModel.page - 1)} className="text-orange-200">
              Previous
            </Link>
          ) : null}
          <span className="text-white/40">Page {readModel.page}</span>
          {hasNextPage ? (
            <Link href={pageHref(readModel.page + 1)} className="text-orange-200">
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
