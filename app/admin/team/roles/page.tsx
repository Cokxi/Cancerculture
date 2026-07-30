export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadTeamRoleAdminReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import TeamRolesAdminClient from "./TeamRolesAdminClient";

export default async function TeamRolesAdminPage() {
  const admin = await requireAdminPage("/admin/team/roles");
  let readModel;

  try {
    readModel = await loadTeamRoleAdminReadModel(
      admin.discord_user_id
    );
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) {
      redirect(destination);
    }

    throw error;
  }

  return <TeamRolesAdminClient readModel={readModel} />;
}
