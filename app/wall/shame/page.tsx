import { supabaseServer } from "@/lib/db/server";
import ShameGrid from "./ShameGrid";
import AnimatedCellShame from "./AnimatedCellShame";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export const dynamic = "force-dynamic";

export default async function WallOfShamePage() {
  const { data: winners } = await supabaseServer
    .from("winner_public_profiles")
    .select(`
      id,
      r2_key,
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

const winnersWithUrls =
  winners?.map((w) => ({
    ...w,
    image_url: getPublicImageUrl(w.r2_key) ?? "",
  })) ?? [];

  return (
  <PageWrapper>
    <div className="p-4 sm:p-6 text-white/85">
  <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">



        <AnimatedCellShame />
        <span>Wall of Shame</span>
      </h1>

      <ShameGrid winners={winnersWithUrls} />
    </div>
    </PageWrapper>
  );
}
