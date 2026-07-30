import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export default async function AdminLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAdminPage("/admin/logs");

  return children;
}
