import { supabaseServer } from "@/lib/db/server";
import ShameGrid from "./ShameGrid";
import AnimatedCellShame from "./AnimatedCellShame";

export const dynamic = "force-dynamic";

export default async function WallOfShamePage() {
  const { data: winners } = await supabaseServer
    .from("winner_public_profiles")
    .select(`
      id,
      image_url,
      cycle_id,
      x_username,
      wallet_address,
      payout_choice,
      split_percent,
      charity,
      vote_count,
      created_at
    `)
    .eq("wall", "shame")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-neutral-950 p-4 sm:p-6 text-white/85">
  <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">


        <AnimatedCellShame />
        <span>Wall of Shame</span>
      </h1>

      <ShameGrid winners={winners ?? []} />
    </div>
  );
}
