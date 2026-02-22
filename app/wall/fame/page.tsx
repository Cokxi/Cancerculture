import { supabaseServer } from "@/lib/db/server";
import FameGrid from "./FameGrid";
import AnimatedCell from "./AnimatedCell";
import PageWrapper from "@/app/components/ui/PageWrapper";

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
    <PageWrapper>
    <div className="p-4 sm:p-6 text-white/90">
  <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">


        <AnimatedCell />
        <span>Wall of Fame</span>
      </h1>

      <FameGrid winners={winners ?? []} />
    </div>
    </PageWrapper>
  );
}
