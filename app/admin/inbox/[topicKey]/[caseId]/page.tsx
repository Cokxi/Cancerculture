export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import TeamInboxCaseDetail from "@/app/components/teamInbox/TeamInboxCaseDetail";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { loadAuthorizedTeamInboxTopics } from "@/lib/teamInbox/teamInbox.server";

export default async function TeamInboxCasePage({ params }: {
  params: Promise<{ topicKey: string; caseId: string }>;
}) {
  const { topicKey, caseId } = await params;
  const authorization = await getTeamAuthorizationContext();
  const topics = await loadAuthorizedTeamInboxTopics(authorization);
  if (!topics.some((topic) => topic.topicKey === topicKey)) notFound();
  return (
    <section className="space-y-6">
      <Link prefetch={false} href={`/admin/inbox/${topicKey}`} className="text-sm text-orange-200 hover:underline">← Topic queue</Link>
      <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">Team Inbox Case</h1>
      <TeamInboxCaseDetail caseId={caseId} isAdmin={authorization.isAdmin} />
    </section>
  );
}
