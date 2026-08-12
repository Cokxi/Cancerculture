import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import UserProfileLink from "../shared/UserProfileLink";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  loadVoteRefundHistoryReadModel,
  VOTE_REFUND_HISTORY_PAGE_SIZE,
  type VoteRefundHistorySubmission,
} from "@/lib/voteRefund/historyReadModel.server";

export const dynamic = "force-dynamic";

function pageHref(page: number) {
  return page > 1
    ? `/admin/logs/vote-refunds?page=${page}`
    : "/admin/logs/vote-refunds";
}

function pluralVotes(count: number) {
  return `${count} vote${count === 1 ? "" : "s"}`;
}

function RefundSubmission({
  submission,
  canViewRefundedVoters,
  isAdmin,
}: {
  submission: VoteRefundHistorySubmission;
  canViewRefundedVoters: boolean;
  isAdmin: boolean;
}) {
  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.025]">
      <summary className="flex cursor-pointer list-none items-center gap-4 p-4 marker:hidden">
        {submission.thumbnailUrl ? (
          <Image
            src={submission.thumbnailUrl}
            alt=""
            width={96}
            height={72}
            unoptimized
            className="h-16 w-24 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-lg border border-white/10 text-[10px] text-white/35">
            Preview unavailable
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">
              Submission #{submission.submissionId}
            </h3>
            <span className="rounded border border-orange-300/25 bg-orange-400/10 px-2 py-1 text-xs font-semibold text-orange-200">
              {pluralVotes(submission.refundedVoteCount)} refunded
            </span>
          </div>
          <p className="mt-2 text-xs text-white/50">
            Submitted by{" "}
            {submission.submitter ? (
              <UserProfileLink
                discordUserId={submission.submitter.discordUserId}
                label={
                  submission.submitter.label ??
                  submission.submitter.discordUserId
                }
                publicProfileId={submission.submitter.publicProfileId}
              />
            ) : (
              "Unavailable"
            )}
          </p>
          <p className="mt-1 text-xs text-white/35">
            Open for refund actor, time and voter details
          </p>
        </div>
        <span aria-hidden className="text-white/45 group-open:rotate-180">
          ▼
        </span>
      </summary>

      <div className="border-t border-white/10 p-4">
        <div className="grid gap-3">
          {submission.actions.map((action) => (
            <section
              key={action.id}
              className="rounded-lg border border-white/10 bg-black/20 p-3"
            >
              <dl className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                <dt className="text-white/40">Refunded by</dt>
                <dd className="min-w-0">
                  <UserProfileLink
                    discordUserId={action.actor.discordUserId}
                    label={action.actor.label ?? action.actor.discordUserId}
                    publicProfileId={action.actor.publicProfileId}
                  />
                </dd>
                <dt className="text-white/40">When</dt>
                <dd>{new Date(action.occurredAt).toLocaleString()}</dd>
                <dt className="text-white/40">Refunded</dt>
                <dd>{pluralVotes(action.refundedVoteCount)}</dd>
                <dt className="text-white/40">Cycle vote limit</dt>
                <dd>{action.votesPerUser} per user</dd>
                <dt className="text-white/40">Reason category</dt>
                <dd>Confirmed disqualification</dd>
                {isAdmin && action.adminAudit ? (
                  <>
                    <dt className="text-white/40">Optional audit note</dt>
                    <dd className="break-words text-white/70">
                      {action.adminAudit.reasonText ?? "No note provided"}
                    </dd>
                    <dt className="text-white/40">Actor role</dt>
                    <dd>{action.adminAudit.actorRole}</dd>
                    <dt className="text-white/40">Capability</dt>
                    <dd>{action.adminAudit.requiredCapability}</dd>
                  </>
                ) : null}
              </dl>

              <div className="mt-3 border-t border-white/10 pt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-white/40">
                  Refunded voters
                </p>
                {canViewRefundedVoters && action.refundedVoters ? (
                  <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                    {action.refundedVoters.map((voter) => (
                      <li
                        key={voter.discordUserId}
                        className="rounded border border-white/10 px-2 py-1"
                      >
                        <UserProfileLink
                          discordUserId={voter.discordUserId}
                          label={voter.label ?? voter.discordUserId}
                          publicProfileId={voter.publicProfileId}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-white/45">
                    Requires both Vote Refund History and Vote Logs access.
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </details>
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
          Successful selective refunds grouped by cycle and submission. Voter
          identities appear only with the additional Vote Logs permission.
        </p>
      </header>

      {readModel.cycles.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
          No vote refunds have been recorded.
        </p>
      ) : (
        <div className="grid gap-7">
          {readModel.cycles.map((cycle) => (
            <section key={`${cycle.cycleId}:${cycle.resetCount}`}>
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-white/10 pb-2">
                <div>
                  <h2 className="text-lg font-semibold">
                    Cycle internal ID #{cycle.cycleId}
                  </h2>
                  <p className="text-xs text-white/40">
                    Attempt {cycle.resetCount}
                  </p>
                </div>
                <p className="text-sm text-white/55">
                  {pluralVotes(cycle.refundedVoteCount)} on this page
                </p>
              </div>
              <div className="grid gap-3">
                {cycle.submissions.map((submission) => (
                  <RefundSubmission
                    key={submission.submissionId}
                    submission={submission}
                    canViewRefundedVoters={readModel.canViewRefundedVoters}
                    isAdmin={readModel.isAdmin}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {readModel.total > VOTE_REFUND_HISTORY_PAGE_SIZE ? (
        <nav
          aria-label="Vote Refund History pages"
          className="mt-6 flex gap-4 text-sm"
        >
          {readModel.page > 1 ? (
            <Link href={pageHref(readModel.page - 1)} className="text-orange-200">
              Previous
            </Link>
          ) : null}
          <span className="text-white/40">Event page {readModel.page}</span>
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
