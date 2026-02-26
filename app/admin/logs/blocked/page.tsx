export const dynamic = "force-dynamic";

import { requireModOrAdmin, getTeamMember } from "@/lib/auth/guards";
import BlockedCycleLogList from "./blocked-cycle-log-list";

export default async function BlockedLogsPage() {
  await requireModOrAdmin();
  const member = await getTeamMember();

  return (
    <div>
      <h1 className="text-xl mb-4">Blocked Users</h1>
      <BlockedCycleLogList isAdmin={member.role === "admin"} />
    </div>
  );
}