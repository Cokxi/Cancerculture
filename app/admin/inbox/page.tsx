export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { loadTeamInboxOverview } from "@/lib/teamInbox/teamInbox.server";

export default async function TeamInboxPage() {
  const authorization = await getTeamAuthorizationContext();
  const topics = await loadTeamInboxOverview(authorization);
  if (topics.length === 0 && !authorization.isAdmin) notFound();
  return (
    <section className="space-y-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-300/70">Topic-based queues</p>
        <h1 className="mt-2 font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">Team Inbox</h1>
        <p className="mt-3 max-w-3xl text-sm text-white/65">
          Each topic keeps its own capability boundary, work state, assignment, and permanent timeline.
        </p>
      </header>
      {topics.length === 0 ? (
        <p className="rounded-2xl border border-white/10 bg-black/35 p-8 text-center text-white/65">
          No Team Inbox topics are available yet. Historical topics will remain here once activated.
        </p>
      ) : <div className="grid gap-4 md:grid-cols-2">
        {topics.map((topic) => (
          <Link
            key={topic.topicKey}
            href={`/admin/inbox/${topic.topicKey}`}
            className="rounded-2xl border border-white/10 bg-black/35 p-5 outline-none hover:border-orange-400/50 focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            <h2 className="font-['Permanent_Marker'] text-2xl text-orange-300">{topic.displayName}</h2>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-orange-500/15 px-3 py-1 text-orange-100">{topic.newCount ?? 0} New</span>
              <span className="rounded-full bg-white/10 px-3 py-1">{topic.openCount ?? 0} Open</span>
              <span className="rounded-full bg-white/10 px-3 py-1">{topic.inProgressCount ?? 0} In progress</span>
            </div>
          </Link>
        ))}
      </div>}
    </section>
  );
}
