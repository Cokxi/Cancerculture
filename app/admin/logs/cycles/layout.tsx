import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export default async function CycleLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAdminPage("/admin/logs/cycles");

  return children;
}
