export const dynamic = "force-dynamic";

import DisqualificationHistoryList from "@/app/components/profile/DisqualificationHistoryList";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getSessionState } from "@/lib/auth/sessionState";
import { loadOwnDisqualificationHistory } from "@/lib/profile/disqualificationHistoryReadModel.server";
import { redirect } from "next/navigation";

const HISTORY_PATH = "/my-profile/disqualifications";

export default async function MyDisqualificationHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sessionState = await getSessionState();

  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${HISTORY_PATH}`);
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
      <main className="mx-auto max-w-3xl px-4 py-10 text-white">
        <div
          className="rounded-2xl border border-white/10 bg-black/70 p-8 text-center"
          role="status"
        >
          Disqualification history is temporarily unavailable.
        </div>
      </main>
    );
  }

  const params = await searchParams;
  let page: Awaited<ReturnType<typeof loadOwnDisqualificationHistory>>;

  try {
    page = await loadOwnDisqualificationHistory({
      cursor: params.after ?? null,
    });
  } catch (error) {
    if (getAuthErrorStatus(error) === 400) {
      redirect(HISTORY_PATH);
    }
    throw error;
  }
  const nextHref = page.nextCursor
    ? `${HISTORY_PATH}?after=${encodeURIComponent(page.nextCursor)}`
    : null;

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-10 text-white">
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
          My Moderation History
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-gray-300">
          This private view shows recorded disqualifications and
          reinstatements for your submissions. A recorded DQ reason and
          explanation are shown to you; moderator identities, internal
          evidence, sources, and request data are not disclosed here.
        </p>
      </header>

      <DisqualificationHistoryList
        page={page}
        nextHref={nextHref}
      />
    </main>
  );
}
