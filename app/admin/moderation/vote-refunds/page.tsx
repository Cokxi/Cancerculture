import Link from "next/link";
import { redirect } from "next/navigation";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  loadVoteRefundReadModel,
  VOTE_REFUND_CANDIDATE_PAGE_SIZE,
} from "@/lib/voteRefund/readModel.server";
import VoteRefundPanel from "./VoteRefundPanel";

export const dynamic = "force-dynamic";

function pageHref(page: number) {
  return page > 1
    ? `/admin/moderation/vote-refunds?page=${page}`
    : "/admin/moderation/vote-refunds";
}

export default async function VoteRefundsPage({
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
    readModel = await loadVoteRefundReadModel({ page });
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const hasNextPage = readModel.page * readModel.pageSize < readModel.total;

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-300/80">
          Critical action · Selective only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">Vote Refunds</h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Refund votes only after a disqualification is considered final. A
          disqualified submission keeps every vote until it is explicitly
          selected here.
        </p>
      </header>

      {!readModel.cycle ? (
        <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
          Vote refunds are available only while the current cycle is in the
          open voting phase.
        </p>
      ) : readModel.candidates.length === 0 ? (
        <p className="rounded-xl border border-white/10 p-5 text-sm text-white/50">
          Cycle #{readModel.cycle.id} has no disqualified submissions with
          refundable votes on this page.
        </p>
      ) : (
        <VoteRefundPanel
          cycle={readModel.cycle}
          candidates={readModel.candidates}
        />
      )}

      {readModel.cycle && readModel.total > VOTE_REFUND_CANDIDATE_PAGE_SIZE ? (
        <nav aria-label="Vote Refund pages" className="mt-6 flex gap-4 text-sm">
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
