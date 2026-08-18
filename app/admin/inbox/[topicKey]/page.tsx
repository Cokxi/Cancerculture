export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ExactDiscordIdSearch from "@/app/components/teamInbox/ExactDiscordIdSearch";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { parseTeamInboxCursor } from "@/lib/teamInbox/teamInboxCursor";
import {
  loadAuthorizedTeamInboxTopics,
  loadTeamInboxCases,
} from "@/lib/teamInbox/teamInbox.server";

const FILTERS = ["new", "open", "claimed_by_me", "in_progress", "solved", "all"] as const;

export default async function TeamInboxTopicPage({ params, searchParams }: {
  params: Promise<{ topicKey: string }>;
  searchParams: Promise<{ filter?: string; username?: string; after?: string }>;
}) {
  const [{ topicKey }, query] = await Promise.all([params, searchParams]);
  const authorization = await getTeamAuthorizationContext();
  const topics = await loadAuthorizedTeamInboxTopics(authorization);
  const topic = topics.find((candidate) => candidate.topicKey === topicKey);
  if (!topic) notFound();
  const filter = FILTERS.includes(query.filter as typeof FILTERS[number]) ? query.filter! : "new";
  const username = query.username?.trim().slice(0, 80) || null;
  const cursor = parseTeamInboxCursor(query.after);
  if (query.after && !cursor) redirect(`/admin/inbox/${topicKey}?filter=${filter}`);
  const page = await loadTeamInboxCases({
    authorization, topicKey, filter, username,
    beforeUpdatedAt: cursor?.at ?? null,
    beforeId: cursor?.id ?? null,
  });
  const base = new URLSearchParams({ filter });
  if (username) base.set("username", username);
  const nextHref = page.nextCursor
    ? `/admin/inbox/${topicKey}?${new URLSearchParams([...base, ["after", page.nextCursor]]).toString()}`
    : null;
  return (
    <section className="space-y-6">
      <header>
        <Link href="/admin/inbox" className="text-sm text-orange-200 hover:underline">← Team Inbox</Link>
        <h1 className="mt-3 font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">{topic.displayName}</h1>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Case filters">
        {FILTERS.map((entry) => (
          <Link key={entry} href={`/admin/inbox/${topicKey}?filter=${entry}`} aria-current={filter === entry ? "page" : undefined} className="rounded-full border border-white/15 px-3 py-2 text-sm aria-[current=page]:border-orange-400 aria-[current=page]:bg-orange-500/15">
            {entry.replaceAll("_", " ")}
          </Link>
        ))}
      </nav>
      <form method="get" className="flex flex-wrap gap-3">
        <input type="hidden" name="filter" value={filter} />
        <label className="sr-only" htmlFor="username-filter">Username</label>
        <input id="username-filter" name="username" defaultValue={username ?? ""} maxLength={80} placeholder="Filter by username" className="min-h-11 rounded-lg border border-white/15 bg-black px-3" />
        <button className="min-h-11 rounded-lg border border-white/15 px-4">Apply</button>
      </form>
      <ExactDiscordIdSearch topicKey={topicKey} />
      <ul className="space-y-3" aria-label="Team Inbox cases">
        {page.items.map((item) => typeof item.id === "string" ? (
          <li key={item.id}>
            <Link prefetch={false} href={`/admin/inbox/${topicKey}/${item.id}`} className="block rounded-2xl border border-white/10 bg-black/35 p-5 hover:border-orange-400/45">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-semibold">{typeof item.username === "string" ? item.username : "Account"}</span>
                <span className="text-xs uppercase tracking-wide text-white/55">{typeof item.status === "string" ? item.status.replaceAll("_", " ") : "case"}</span>
              </div>
              {item.isNew === true ? <span className="mt-3 inline-block rounded-full bg-orange-500 px-3 py-1 text-xs font-bold text-black">New</span> : null}
              {typeof item.assigneeDisplayName === "string" ? <p className="mt-2 text-xs text-white/50">Assigned to {item.assigneeDisplayName}</p> : null}
            </Link>
          </li>
        ) : null)}
      </ul>
      {page.items.length === 0 ? <p className="rounded-2xl border border-white/10 p-6 text-center text-white/60">No cases in this view.</p> : null}
      {nextHref ? <Link href={nextHref} className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-4">Older cases</Link> : null}
    </section>
  );
}
