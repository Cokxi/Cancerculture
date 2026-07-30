import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getResolvedTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation.server";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import TeamAreaShell from "./TeamAreaShell";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  let navigation;

  try {
    navigation = await getResolvedTeamAreaNavigation();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }

  return (
    <TeamAreaShell navigation={navigation}>
      {children}
    </TeamAreaShell>
  );
}
