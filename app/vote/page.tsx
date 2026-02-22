import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/db/server";
import { requireSession } from "@/lib/auth/requireSession";
import VoteClient from "./VoteClient";
import PageWrapper from "@/app/components/ui/PageWrapper";

export const dynamic = "force-dynamic";

export default async function VotePage() {
  let discordUserId: string;

  // 🔐 Session-required Page
  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    // ❗ KEIN Loop: nur EIN Redirect, dann OAuth
    redirect("/api/auth/discord/login?state=/vote");
  }

  const { data: userLog } = await supabaseServer
  .from("user_logs")
  .select("is_banned")
  .eq("discord_user_id", discordUserId)
  .maybeSingle();

const isBanned = userLog?.is_banned === true;


  const { data: cycle } = await supabaseServer
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .single();

  if (!cycle) {
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

  const { data: existingVote } = await supabaseServer
    .from("votes")
    .select("id")
    .eq("cycle_id", cycle.id)
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  const hasVoted = Boolean(existingVote);

  const { data: submissions } = await supabaseServer
    .from("submissions_with_votes")
    .select("id, image_url, vote_count, discord_user_id")
    .eq("cycle_id", cycle.id)
    .eq("is_disqualified", false)
    .order("id", { ascending: true });

  return (
    <PageWrapper>
        <VoteClient
  submissions={submissions ?? []}
  hasVoted={hasVoted}
  discordUserId={discordUserId}
  isBanned={isBanned}
/>
</PageWrapper>
  );
}
