export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/sessionState";
import { resolveOwnMentionDestination } from "@/lib/comments/commentOwner.server";

export default async function OpenOwnMentionPage({
  params,
}: {
  params: Promise<{ mentionId: string }>;
}) {
  const { mentionId } = await params;
  const returnPath = `/my-profile/mentions/open/${encodeURIComponent(mentionId)}`;
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") redirect(`/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`);
  if (sessionState.status === "restricted") redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  if (sessionState.status === "dependency_unavailable") redirect("/my-profile/mentions?status=unavailable");
  const destination = await resolveOwnMentionDestination(sessionState.session.session_id, mentionId);
  redirect(destination ?? "/my-profile/mentions?status=unavailable");
}
