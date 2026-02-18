import { supabaseServer } from "@/lib/db/server";
import FameGrid from "./FameGrid";
import AnimatedCell from "./AnimatedCell";

export const dynamic = "force-dynamic";

export default async function WallOfFamePage() {
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
    .eq("wall", "fame")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-orange-background p-4 sm:p-6 text-white/90">
  <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">

<a
  href="/"
  className="fixed top-4 left-4 z-40 bg-black/70 text-orange-500 px-3 py-2 rounded-full text-sm font-[Permanent_Marker] hover:bg-black"
>
  ← Home
</a>


        <AnimatedCell />
        <span>Wall of Fame</span>
      </h1>

      <FameGrid winners={winners ?? []} />
    </div>
  );
}
