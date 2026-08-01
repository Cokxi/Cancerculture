import type { ReactNode } from "react";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function SubmissionModerationLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireTeamCapabilityPage(
    "logs.submission_moderation.view",
    "/admin/logs/moderation"
  );

  return children;
}
