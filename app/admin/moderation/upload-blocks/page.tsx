export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import SubmissionUploadBlocks from "@/app/admin/logs/blocked/SubmissionUploadBlocks";

export default async function UploadBlocksPage() {
  const authorization = await requireTeamCapabilityPage(
    "users.upload_blocks.view",
    "/admin/moderation/upload-blocks"
  );

  return (
    <main className="p-6">
      <h1 className="mb-4 text-xl">Cycle Upload Protection</h1>
      <SubmissionUploadBlocks
        canEmergencyUnblock={authorization.isAdmin}
      />
    </main>
  );
}
