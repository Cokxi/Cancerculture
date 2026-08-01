import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export default async function VoteLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireAdminPage("/admin/logs/votes");

  return children;
}
