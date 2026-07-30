export const dynamic = "force-dynamic";

import { requireAdminPage } from "@/lib/auth/pageAccess";
import BlockedCycleLogList from "./blocked-cycle-log-list";
import SubmissionUploadBlocks from "./SubmissionUploadBlocks";

export default async function BlockedLogsPage() {
  await requireAdminPage("/admin/logs/blocked");

  return (
    <div>
      <h1 className="text-xl mb-4">Blocked Users</h1>
      <SubmissionUploadBlocks />
      <BlockedCycleLogList isAdmin />
    </div>
  );
}
