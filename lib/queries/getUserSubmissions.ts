import { supabaseServer } from "@/lib/db/server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

type UserSubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  is_disqualified: boolean;
  disqualification_reason_code: string | null;
  disqualification_reason_text: string | null;
  disqualified_by_discord_username: string | null;
  vote_count: number | null;
  rank: number | null;
};

type CycleVoteRow = {
  cycle_id: number;
  vote_count: number | null;
};

type CycleCountRow = {
  cycle_id: number;
};

export async function getUserSubmissions(discord_user_id: string) {
  const supabase = supabaseServer;

  
  const { data, error } = await supabase
    .from("submissions_with_votes")
    .select(`
  id,
  cycle_id,
  r2_key,
  is_disqualified,
  disqualification_reason_code,
  disqualification_reason_text,
  disqualified_by_discord_username,
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

  const submissions = data as UserSubmissionRow[];
  const cycleIds = Array.from(
    new Set(submissions.map((item) => item.cycle_id))
  );

  const { data: allCycleSubmissions } = await supabase
    .from("submissions_with_votes")
    .select("cycle_id, vote_count")
    .in("cycle_id", cycleIds)
    .eq("is_disqualified", false);

  const { data: cycleCounts } = await supabase
    .from("submissions")
    .select("cycle_id")
    .in("cycle_id", cycleIds)
    .eq("is_disqualified", false);

  const tieMap = new Map<string, number>();
  const totalByCycle = new Map<number, number>();

  (allCycleSubmissions as CycleVoteRow[] | null)?.forEach((item) => {
    const key = `${item.cycle_id}-${item.vote_count}`;
    tieMap.set(key, (tieMap.get(key) ?? 0) + 1);
  });

  (cycleCounts as CycleCountRow[] | null)?.forEach((item) => {
    totalByCycle.set(
      item.cycle_id,
      (totalByCycle.get(item.cycle_id) ?? 0) + 1
    );
  });

  return submissions.map((item) => {
    const tieKey = `${item.cycle_id}-${item.vote_count}`;

    return {
      id: item.id,
      cycle_id: item.cycle_id,
      image_url: getPublicImageUrl(item.r2_key) ?? "",
      is_disqualified: item.is_disqualified,
      disqualification_reason_code: item.disqualification_reason_code ?? null,
      disqualification_reason_text: item.disqualification_reason_text ?? null,
      disqualified_by_discord_username: item.disqualified_by_discord_username ?? null,
      vote_count: item.vote_count ?? 0,
      rank: item.rank ?? null,
      total: totalByCycle.get(item.cycle_id) ?? 0,
      tie_count: tieMap.get(tieKey) ?? 1,
    };
  });
}
