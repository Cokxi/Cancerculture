export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionState } from "@/lib/auth/sessionState";
import { resolveOwnCommentDestination } from "@/lib/comments/commentOwner.server";

export default async function OpenOwnCommentPage({
  params,
}: {
  params: Promise<{ publicCommentId: string }>;
}) {
  const { publicCommentId } = await params;
  const returnPath = `/my-profile/comments/open/${encodeURIComponent(publicCommentId)}`;
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") redirect(`/api/auth/discord/login?state=${encodeURIComponent(returnPath)}`);
  if (sessionState.status === "restricted") redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  if (sessionState.status === "dependency_unavailable") redirect("/my-profile/comments?status=unavailable");
  const destination = await resolveOwnCommentDestination(sessionState.session.session_id, publicCommentId);
  redirect(destination ?? "/my-profile/comments?status=unavailable");
}
