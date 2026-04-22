export const dynamic = "force-dynamic";

import { getTeamMember } from "@/lib/auth/guards";
import { redirect } from "next/navigation";
import BlockedCycleLogList from "./blocked-cycle-log-list";

export default async function BlockedLogsPage() {
  let member;

  try {
    member = await getTeamMember();
  } catch {
    redirect("/403");
  }

  return (
    <div>
      <h1 className="text-xl mb-4">Blocked Users</h1>
      <BlockedCycleLogList isAdmin={member.role === "admin"} />
    </div>
  );
}
