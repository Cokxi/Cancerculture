export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import NotificationList from "@/app/components/notifications/NotificationList";
import BackButton from "@/app/components/ui/BackButton";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { getSessionState } from "@/lib/auth/sessionState";
import { loadOwnNotifications } from "@/lib/notifications/ownerNotifications.server";

const NOTIFICATIONS_PATH = "/notifications";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${NOTIFICATIONS_PATH}`);
  }
  if (sessionState.status === "restricted") {
    redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  }
  if (sessionState.status === "dependency_unavailable") {
    return <main className="mx-auto max-w-3xl px-4 py-10 text-white">Notifications are temporarily unavailable.</main>;
  }

  const params = await searchParams;
  let page;
  try {
    page = await loadOwnNotifications({
      sessionId: sessionState.session.session_id,
      cursor: params.after ?? null,
    });
  } catch (error) {
    if (getAuthErrorStatus(error) === 400) redirect(NOTIFICATIONS_PATH);
    throw error;
  }
  return (
    <main className="mx-auto max-w-3xl space-y-7 px-4 py-10 text-white">
      <BackButton href="/" label="Home" />
      <header className="rounded-2xl border border-white/10 bg-black/40 p-6">
        <h1 className="font-['Permanent_Marker'] text-3xl text-[var(--orange-main)]">Notifications</h1>
        <p className="mt-2 text-sm text-white/65">
          Private account updates. Each destination is resolved again after account authorization.
        </p>
      </header>
      <NotificationList initialItems={page.items} initialNextCursor={page.nextCursor} />
    </main>
  );
}
