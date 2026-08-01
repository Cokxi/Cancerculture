import type { ReactNode } from "react";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function AvatarUploadLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireTeamCapabilityPage(
    "logs.avatar_uploads.view",
    "/admin/logs/avatar-uploads"
  );

  return children;
}
