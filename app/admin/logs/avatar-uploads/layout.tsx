import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export default async function AvatarUploadLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAdminPage("/admin/logs/avatar-uploads");

  return children;
}
