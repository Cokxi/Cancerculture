export const dynamic = "force-dynamic";

import DisqualificationHistoryList from "@/app/components/profile/DisqualificationHistoryList";
import BackButton from "@/app/components/ui/BackButton";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadTeamDisqualificationHistory } from "@/lib/profile/disqualificationHistoryReadModel.server";
import { notFound, redirect } from "next/navigation";

const LIST_PATH = "/admin/users/disqualifications";

export default async function UserDisqualificationHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicProfileId: string }>;
  searchParams: Promise<{ after?: string }>;
}) {
  const { publicProfileId } = await params;
  const query = await searchParams;
  let result: Awaited<
    ReturnType<typeof loadTeamDisqualificationHistory>
  >;

  try {
    result = await loadTeamDisqualificationHistory({
      publicProfileId,
      cursor: query.after ?? null,
    });
  } catch (error) {
    if (getAuthErrorStatus(error) === 404) notFound();
    if (getAuthErrorStatus(error) === 400) {
      redirect(`${LIST_PATH}/${encodeURIComponent(publicProfileId)}`);
    }

    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }

  const detailPath = `${LIST_PATH}/${encodeURIComponent(
    result.profile.publicProfileId
  )}`;
  const nextHref = result.page.nextCursor
    ? `${detailPath}?after=${encodeURIComponent(result.page.nextCursor)}`
    : null;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6 text-white">
      <BackButton href={LIST_PATH} label="DQ Profiles" />

      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-semibold">
          Disqualification History
        </h1>
        <p className="mt-2 text-[var(--orange-dark)]">
          {result.profile.label}
        </p>
        <p className="mt-3 max-w-3xl text-sm text-gray-300">
          Delegated viewers receive broad reason categories only.
          Owner access additionally receives exact audit context, while
          raw evidence, object keys, request payloads, votes, and refund
          data remain excluded.
        </p>
      </header>

      <DisqualificationHistoryList
        page={result.page}
        nextHref={nextHref}
      />
    </main>
  );
}
