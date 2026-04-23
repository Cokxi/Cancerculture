import BackButton from "@/app/components/ui/BackButton";
import CycleHistoryClient from "./CycleHistoryClient";
import { getTeamMember } from "@/lib/auth/guards";
import { requireSession } from "@/lib/auth/requireSession";
import { getCycleHistorySummaries } from "@/lib/cycles/getCycleHistoryData";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";

export default async function CycleHistoryPage() {
  await requireSession();
  let isAdmin = false;
  let canModerate = false;

  try {
    const member = await getTeamMember();
    isAdmin = member.role === "admin";
    canModerate =
      member.role === "admin" || member.role === "mod";
  } catch {}

  const cycles = await getCycleHistorySummaries({
    isAdminView: isAdmin,
  });
  const sponsoredMetaEntries = await Promise.all(
    cycles.map(async (cycle) => [
      cycle.id,
      await getCycleSponsoredMeta(cycle.id),
    ])
  );
  const sponsoredMetaByCycleId = Object.fromEntries(
    sponsoredMetaEntries
  );

  return (
    <>
      <BackButton href="/" label="Back" />

      <div className="mx-auto max-w-6xl px-4 py-16 text-white">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
            Cycle History
          </h1>
        </div>

        {cycles.length === 0 ? (
          <div className="rounded-2xl border border-orange-500/30 bg-black/50 p-8 text-center text-white/70">
            No finished cycles yet.
          </div>
        ) : (
          <CycleHistoryClient
            canModerate={canModerate}
            cycles={cycles}
            isAdmin={isAdmin}
            sponsoredMetaByCycleId={sponsoredMetaByCycleId}
          />
        )}
      </div>
    </>
  );
}
