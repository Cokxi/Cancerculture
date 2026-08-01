import type { ReactNode } from "react";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function VoteLogsLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireTeamCapabilityPage(
    "logs.votes.view",
    "/admin/logs/votes"
  );

  return children;
}
