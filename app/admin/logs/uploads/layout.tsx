import type { ReactNode } from "react";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function UploadLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireTeamCapabilityPage(
    "logs.uploads.view",
    "/admin/logs/uploads"
  );

  return children;
}
