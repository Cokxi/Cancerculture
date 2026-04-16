import { supabaseServer } from "@/lib/db/server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export async function getUserSubmissions(discord_user_id: string) {
  const supabase = supabaseServer;

  
  const { data, error } = await supabase
    .from("submissions_with_votes")
    .select(`
      id,
      cycle_id,
      r2_key,
      is_disqualified,
      vote_count,
      rank
    `)
    .eq("discord_user_id", discord_user_id)
    .order("cycle_id", { ascending: false });

  if (error) {
    console.error("FULL ERROR:", JSON.stringify(error, null, 2));
    return [];
  }

  
  if (!data || data.length === 0) return [];

  const cycleId = data[0].cycle_id;

  
  const { data: allCycleSubmissions } = await supabase
    .from("submissions_with_votes")
    .select("cycle_id, vote_count")
    .eq("cycle_id", cycleId)
    .eq("is_disqualified", false);

  
  const { count } = await supabase
    .from("submissions")
    .select("*", { count: "exact", head: true })
    .eq("cycle_id", cycleId)
    .eq("is_disqualified", false);

  
  const tieMap = new Map<string, number>();

  allCycleSubmissions?.forEach((item: any) => {
    const key = `${item.cycle_id}-${item.vote_count}`;
    tieMap.set(key, (tieMap.get(key) ?? 0) + 1);
  });

  
  return data.map((item: any) => {
    const tieKey = `${item.cycle_id}-${item.vote_count}`;

    return {
      id: item.id,
      cycle_id: item.cycle_id,
      image_url: getPublicImageUrl(item.r2_key) ?? "",
      is_disqualified: item.is_disqualified,
      vote_count: item.vote_count ?? 0,
      rank: item.rank ?? null,
      total: count ?? 0,
      tie_count: tieMap.get(tieKey) ?? 1,
    };
  });
}