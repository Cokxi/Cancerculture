export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/sessionState";
import { resolveOwnNotificationDestination } from "@/lib/notifications/ownerNotifications.server";

export default async function OpenNotificationPage({
  params,
}: {
  params: Promise<{ notificationId: string }>;
}) {
  const { notificationId } = await params;
  const sessionState = await getSessionState();
  const returnPath = `/notifications/open/${encodeURIComponent(notificationId)}`;
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`);
  }
  if (sessionState.status === "restricted") {
    redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  }
  if (sessionState.status === "dependency_unavailable") redirect("/notifications");
  const destination = await resolveOwnNotificationDestination(
    sessionState.session.session_id,
    notificationId
  );
  if (!destination) notFound();
  redirect(destination);
}
