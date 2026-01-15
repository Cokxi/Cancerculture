import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/db/server";
import { createOwnerHash } from "@/lib/security/ownerHash";
import VoteGrid from "./VoteGrid";

export const dynamic = "force-dynamic";

export default async function VotePage() {
  // 🔐 Discord Auth via Cookie
  const cookieStore = await cookies();
  const discordUserId = cookieStore.get("discord_user_id")?.value;

  if (!discordUserId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-xl text-[var(--orange-dark)] font-[Permanent_Marker]">

        Please verify with Discord to vote.
      </div>
    );
  }

  // 🔁 Aktiven Cycle holen
  const { data: cycle } = await supabaseServer
    .from("voting_cycles")
    .select("*")
    .eq("status", "active")
    .single();

  if (!cycle) {
    return (
      <div className="min-h-screen flex items-center justify-center text-xl text-[var(--orange-dark)] font-[Permanent_Marker]">

        No active voting cycle
      </div>
    );
  }

  // 🔑 Owner Hash (MUSS IDENTISCH zum Vote-API sein)
  const ownerHash = createOwnerHash(discordUserId, cycle.id);

  // 🛑 Schon gevotet?
  const { data: existingVote } = await supabaseServer
    .from("votes")
    .select("id")
    .eq("cycle_id", cycle.id)
    .eq("owner_hash", ownerHash)
    .maybeSingle();

  const hasVoted = Boolean(existingVote);

  // 🖼️ Submissions laden (inkl. owner_hash für UI-Logik)
  const { data: submissions } = await supabaseServer
  .from("submissions_with_votes")
  .select("id, image_url, owner_hash, vote_count")
  .eq("cycle_id", cycle.id)
  .eq("is_disqualified", false)
  .order("id", { ascending: true });


  return (
    <VoteGrid
      submissions={submissions ?? []}
      hasVoted={hasVoted}
      currentOwnerHash={ownerHash}
    />
  );
}
