import BackButton from "@/app/components/ui/BackButton";
import CycleHistoryClient from "./CycleHistoryClient";
import { getTeamMember } from "@/lib/auth/guards";
import { getCycleHistorySummariesPage } from "@/lib/cycles/getCycleHistoryData";
import {
  hasTeamCapability,
  isAdminTeamRole,
} from "@/lib/auth/teamRoles";

export default async function CycleHistoryPage() {
  let isAdmin = false;
  let canModerate = false;

  try {
    const member = await getTeamMember();
    isAdmin = isAdminTeamRole(member.role);
    canModerate = hasTeamCapability(
      member.role,
      "canModerateSubmissionPhase"
    );
  } catch {}

  const initialPage = await getCycleHistorySummariesPage({
    isAdminView: isAdmin,
  });

  return (
    <>
      <BackButton href="/" label="Home" />

      <div className="mx-auto max-w-6xl px-4 py-16 text-white">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            Cycle History
          </h1>
        </div>

        {initialPage.items.length === 0 ? (
          <div className="rounded-2xl border border-orange-500/30 bg-black/50 p-8 text-center text-white/70">
            No finished cycles yet.
          </div>
        ) : (
          <CycleHistoryClient
            canModerate={canModerate}
            initialPage={initialPage}
            isAdmin={isAdmin}
          />
        )}
      </div>
    </>
  );
}
