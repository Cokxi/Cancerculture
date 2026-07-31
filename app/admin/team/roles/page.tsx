export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import {
  loadRolesPermissionsAdminReadModel,
  type TeamRoleAdminCapability,
} from "@/lib/auth/teamRoleAdminReadModel";
import { REGISTERED_TEAM_CAPABILITY_KEYS } from "@/lib/auth/teamCapabilityRegistry";
import RolesPermissionsClient, {
  type RolesPermissionsViewModel,
} from "./RolesPermissionsClient";

export default async function TeamRolesAdminPage() {
  const admin = await requireAdminPage("/admin/team/roles");
  let fullReadModel;

  try {
    fullReadModel = await loadRolesPermissionsAdminReadModel(
      admin.discord_user_id
    );
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) {
      redirect(destination);
    }

    throw error;
  }

  const capabilities = REGISTERED_TEAM_CAPABILITY_KEYS.map((key) =>
    fullReadModel.capabilities.find(
      (capability) => capability.key === key
    )
  ).filter(
    (
      capability
    ): capability is TeamRoleAdminCapability => capability !== undefined
  );
  const readModel: RolesPermissionsViewModel = {
    roles: fullReadModel.roles,
    capabilities,
    activeNonAdminRoles: fullReadModel.activeNonAdminRoles,
  };

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          Admin only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Roles &amp; Permissions
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Draft permission differences locally, review the complete set, and
          save the batch atomically.
        </p>
      </header>
      <RolesPermissionsClient readModel={readModel} />
    </div>
  );
}
