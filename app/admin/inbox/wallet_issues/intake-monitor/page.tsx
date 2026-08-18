export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import WalletIssueIntakeMonitor from "@/app/components/teamInbox/WalletIssueIntakeMonitor";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { loadAuthorizedTeamInboxTopics } from "@/lib/teamInbox/teamInbox.server";

export default async function WalletIssueIntakeMonitorPage() {
  const authorization = await getTeamAuthorizationContext();
  const topics = await loadAuthorizedTeamInboxTopics(authorization);
  if (!topics.some((topic) => topic.topicKey === "wallet_issues")) notFound();
  return (
    <section className="space-y-6">
      <Link href="/admin/inbox/wallet_issues" className="text-sm text-orange-200 hover:underline">← Wallet Issues</Link>
      <header>
        <p className="text-xs uppercase tracking-wide text-white/50">Permission-protected shadow box</p>
        <h1 className="mt-2 font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">Intake Monitor</h1>
      </header>
      <WalletIssueIntakeMonitor />
    </section>
  );
}
