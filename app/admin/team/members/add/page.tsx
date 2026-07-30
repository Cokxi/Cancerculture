import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadAddTeamMemberAdminReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import AddTeamMemberClient from "./AddTeamMemberClient";

export const dynamic = "force-dynamic";

export default async function AddTeamMemberPage() {
  const admin = await requireAdminPage("/admin/team/members/add");
  let readModel;

  try {
    readModel = await loadAddTeamMemberAdminReadModel(
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
    <div className="mx-auto max-w-3xl pb-12">
      <header className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          Admin only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Add Team Member
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-white/60">
          Add a known Discord identity with an active non-Admin role.
          Owner access remains a separate protected transition.
        </p>
        <Link
          href="/admin/team/members"
          className="mt-3 inline-block rounded-sm text-sm text-orange-200 outline-none hover:text-orange-100 focus-visible:ring-2 focus-visible:ring-orange-300"
        >
          Back to Team Members
        </Link>
      </header>

      <AddTeamMemberClient
        roles={readModel.activeNonAdminRoles}
      />
    </div>
  );
}
