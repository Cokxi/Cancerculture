import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/db/server";
import { requireSession } from "@/lib/auth/requireSession";
import VoteClient from "./VoteClient";

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
      <div className="min-h-screen flex items-center justify-center text-xl">
        No active voting cycle
      </div>
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
    <VoteClient
  submissions={submissions ?? []}
  hasVoted={hasVoted}
  discordUserId={discordUserId}
  isBanned={isBanned}
/>

  );
}
