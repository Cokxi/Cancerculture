export const dynamic = "force-dynamic";

import { getTeamMember } from "@/lib/auth/guards";
import { redirect } from "next/navigation";
import BlockedCycleLogList from "./blocked-cycle-log-list";
import SubmissionUploadBlocks from "./SubmissionUploadBlocks";
import { isAdminTeamRole } from "@/lib/auth/teamRoles";

export default async function BlockedLogsPage() {
  let member;

  try {
    member = await getTeamMember();
  } catch {
    redirect("/403");
  }

  const isAdmin = isAdminTeamRole(member.role);

  return (
    <div>
      <h1 className="text-xl mb-4">Blocked Users</h1>
      {isAdmin ? <SubmissionUploadBlocks /> : null}
      <BlockedCycleLogList isAdmin={isAdmin} />
    </div>
  );
}
