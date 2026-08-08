export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadDisqualificationProfiles } from "@/lib/profile/disqualificationHistoryReadModel.server";

const PAGE_PATH = "/admin/users/disqualifications";

function formatUtc(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export default async function UserDisqualificationProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const params = await searchParams;
  let page: Awaited<ReturnType<typeof loadDisqualificationProfiles>>;

  try {
    page = await loadDisqualificationProfiles({
      cursor: params.after ?? null,
    });
  } catch (error) {
    if (getAuthErrorStatus(error) === 400) redirect(PAGE_PATH);

    const destination = getTeamPageAccessRedirect(error);
    if (destination) redirect(destination);
    throw error;
  }
  const nextHref = page.nextCursor
    ? `${PAGE_PATH}?after=${encodeURIComponent(page.nextCursor)}`
    : null;

  return (
    <main className="space-y-6 p-6 text-white">
      <header>
        <h1 className="text-3xl font-semibold">
          User Disqualification History
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-300">
          Profile-oriented current and reinstated submission history.
          This read permission does not grant any moderation action.
        </p>
      </header>

      {page.items.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/40 p-6 text-sm text-gray-300">
          No recorded user disqualification history is available.
        </div>
      ) : (
        <div className="space-y-3">
          {page.items.map((profile) => (
            <Link
              key={profile.publicProfileId}
              href={`${PAGE_PATH}/${encodeURIComponent(profile.publicProfileId)}`}
              className="block rounded-xl border border-white/10 bg-black/40 p-5 transition hover:border-[var(--orange-dark)]/50 hover:bg-black/55"
            >
              <div className="font-semibold text-[var(--orange-dark)]">
                {profile.label}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-300">
                <span>
                  Current DQs: {profile.currentDisqualifiedCount}
                </span>
                <span>Submissions: {profile.submissionCount}</span>
                <span>Events: {profile.eventCount}</span>
                <span>
                  Latest: {formatUtc(profile.latestEventAt)} UTC
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {nextHref ? (
        <div className="flex justify-center">
          <Link
            href={nextHref}
            className="rounded-full border border-[var(--orange-dark)]/50 px-5 py-2 text-sm text-[var(--orange-dark)] transition hover:bg-[var(--orange-dark)]/10"
          >
            View older profiles
          </Link>
        </div>
      ) : null}
    </main>
  );
}
