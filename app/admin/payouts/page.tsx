export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { hasResolvedTeamCapability } from "@/lib/auth/teamAuthorization";
import { getSimpleTeamPayouts } from "@/lib/payouts/service.server";
import PayoutManager from "./PayoutManager";

export default async function PayoutsPage() {
  const authorization = await requireTeamCapabilityPage("winners.payouts.view", "/admin/payouts");
  const canManage = hasResolvedTeamCapability(authorization, "winners.manage_payouts");
  const payouts = await getSimpleTeamPayouts(authorization.discord_user_id, canManage);
  return <div>
    <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">Payouts</h1>
    <p className="mt-3 max-w-4xl text-sm text-white/60">Winner payouts grouped by Cycle. Amounts are calculated by the server from the locked prize pool and winner choices. The prize pool itself is set in Cycle Management before voting ends.</p>
    <PayoutManager items={payouts.items} canManage={canManage} databaseTime={payouts.databaseTime} />
  </div>;
}
