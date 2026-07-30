import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadTeamMembersAdminReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import TeamMembersClient, {
  type TeamMembersViewModel,
} from "./TeamMembersClient";

export const dynamic = "force-dynamic";

export default async function TeamMembersPage() {
  const admin = await requireAdminPage("/admin/team/members");
  let readModel: TeamMembersViewModel;

  try {
    readModel = await loadTeamMembersAdminReadModel(
      admin.discord_user_id
    );
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) {
      redirect(destination);
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          Admin only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Team Members
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Review current team assignments and manage existing role and
          Owner transitions.
        </p>
      </header>
      <TeamMembersClient readModel={readModel} />
    </div>
  );
}
