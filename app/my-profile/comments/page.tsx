export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
import { OwnCommentsList } from "@/app/my-profile/CommentOwnerLists";
import { getSessionState } from "@/lib/auth/sessionState";
import { loadOwnComments } from "@/lib/comments/commentOwner.server";

const PATH = "/my-profile/comments";

export default async function MyCommentsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") redirect(`/api/auth/discord/login?state=${PATH}`);
  if (sessionState.status === "restricted") redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  if (sessionState.status === "dependency_unavailable") {
    return <main className="mx-auto max-w-3xl px-4 py-10 text-white"><BackButton href="/my-profile" label="My Profile" /><p role="status" className="mt-8 rounded-xl border border-white/10 bg-black/60 p-6">Comments are temporarily unavailable.</p></main>;
  }
  const { after } = await searchParams;
  const page = await loadOwnComments({ sessionId: sessionState.session.session_id, cursor: after ?? null });
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10 text-white">
      <BackButton href="/my-profile" label="My Profile" />
      <div>
        <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">My Comments</h1>
        <p className="mt-2 text-sm text-white/65">Your comments and replies, newest first. Editing does not change their order.</p>
      </div>
      <OwnCommentsList items={page.items} />
      {page.nextCursor ? (
        <Link href={`${PATH}?after=${encodeURIComponent(page.nextCursor)}`} className="inline-flex min-h-11 items-center rounded-full border border-[var(--orange-main)]/45 px-4 py-2 text-sm font-semibold text-[var(--orange-main)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400">Older comments</Link>
      ) : null}
    </main>
  );
}
