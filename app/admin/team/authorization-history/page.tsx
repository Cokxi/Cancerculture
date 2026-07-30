import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { loadTeamAuthorizationHistoryReadModel } from "@/lib/auth/teamRoleAdminReadModel";
import AuthorizationHistoryList from "./AuthorizationHistoryList";

export const dynamic = "force-dynamic";

export default async function AuthorizationHistoryPage() {
  const admin = await requireAdminPage(
    "/admin/team/authorization-history"
  );
  let readModel;

  try {
    readModel = await loadTeamAuthorizationHistoryReadModel(
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
          Admin only · Read-only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Authorization History
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-white/60">
          Latest 50 append-only role, permission, assignment, and Owner
          events.
        </p>
      </header>
      <AuthorizationHistoryList audit={readModel.audit} />
    </div>
  );
}
