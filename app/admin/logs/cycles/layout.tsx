import type { ReactNode } from "react";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function CycleLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireTeamCapabilityPage("cycles.logs.view", "/admin/logs/cycles");

  return children;
}
