import Link from "next/link";
import { getSessionState } from "@/lib/auth/sessionState";
import { getCurrentCommunityPollAnnouncement } from "@/lib/communityPolls/data.server";

export default async function HomeCommunityVoteAnnouncement() {
  const sessionState = await getSessionState().catch(() => null);
  const viewerId = sessionState?.status === "authenticated"
    ? sessionState.session.discord_user_id
    : undefined;
  const announcement = await getCurrentCommunityPollAnnouncement(viewerId).catch(() => null);
  if (!announcement) return null;

  return (
    <section
      data-home-section="community-vote-announcement"
      className="pointer-events-none flex w-full max-w-[900px] justify-center"
    >
      <div className="pointer-events-auto w-full max-w-[760px] rounded-2xl border border-orange-300/50 bg-orange-500/15 p-5 shadow-[0_0_35px_rgba(255,91,31,0.13)] sm:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-orange-200">
          Community Vote open
        </p>
        <h2 className="mt-2 text-xl font-bold text-white">{announcement.question}</h2>
        <p className="mt-2 text-sm text-white/70">
          Vote before {new Intl.DateTimeFormat("en", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(announcement.deadlineAt))}.
        </p>
        <Link
          href={`/community-votes/${announcement.pollPublicId}`}
          className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-[var(--orange-main)] px-4 py-2 font-bold text-black transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200"
        >
          Cast your vote
        </Link>
      </div>
    </section>
  );
}
