import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/requireSession";
import VoteClient from "./VoteClient";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { supabaseServer } from "@/lib/db/server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import { getVoteEligibility } from "@/lib/vote/getVoteEligibility";

export const dynamic = "force-dynamic";

export default async function VotePage() {
  let discordUserId: string;

  
  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    redirect("/api/auth/discord/login?state=/vote");
  }

  const voteEligibility = await getVoteEligibility(discordUserId);

  if (!voteEligibility.activeCycleId) {
    return (
      <PageWrapper>
        <div className="flex items-center justify-center min-h-screen">
          <span className="font-['Permanent_Marker'] text-[var(--orange-main)] text-2xl tracking-wide">
            No active voting cycle
          </span>
        </div>
      </PageWrapper>
    );
  }

  const { data: submissions } = await supabaseServer
    .from("submissions_with_votes")
    .select("id, r2_key, vote_count, discord_user_id")
    .eq("cycle_id", voteEligibility.activeCycleId)
    .eq("is_disqualified", false)
    .order("id", { ascending: true });

  const submissionsWithUrls =
    submissions?.map((s) => ({
      ...s,
      image_url: getPublicImageUrl(s.r2_key) ?? "",
    })) ?? [];

  return (
    <PageWrapper>
      <VoteClient
        submissions={submissionsWithUrls}
        hasVoted={voteEligibility.hasVoted}
        discordUserId={discordUserId}
        isBanned={voteEligibility.isBanned}
      />
    </PageWrapper>
  );
}
