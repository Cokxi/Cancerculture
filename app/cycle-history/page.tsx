import BackButton from "@/app/components/ui/BackButton";
import CycleHistoryClient from "./CycleHistoryClient";
import { requireSession } from "@/lib/auth/requireSession";
import { getCycleHistoryData } from "@/lib/cycles/getCycleHistoryData";

export default async function CycleHistoryPage() {
  await requireSession();
  const cycles = await getCycleHistoryData();

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
          <CycleHistoryClient cycles={cycles} />
        )}
      </div>
    </>
  );
}
