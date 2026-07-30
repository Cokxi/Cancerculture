import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadTeamMembersAdminReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import TeamMembersClient, {
  type TeamMembersViewModel,
} from "./TeamMembersClient";

export const dynamic = "force-dynamic";

export default async function TeamMembersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const admin = await requireAdminPage("/admin/team/members");
  const status = (await searchParams).status;
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
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
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
        </div>
        <Link
          href="/admin/team/members/add"
          className="rounded-lg border border-orange-400/45 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-200 outline-none hover:bg-orange-500/20 focus-visible:ring-2 focus-visible:ring-orange-300"
        >
          Add Team Member
        </Link>
      </header>
      {status === "member-added" ? (
        <p
          role="status"
          className="mb-5 rounded-lg border border-green-500/40 bg-green-950/20 p-4 text-sm text-green-200"
        >
          Team member added. The refreshed list below shows the confirmed
          authorization state.
        </p>
      ) : null}
      <TeamMembersClient readModel={readModel} />
    </div>
  );
}
