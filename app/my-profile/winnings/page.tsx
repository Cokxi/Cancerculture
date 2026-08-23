export const dynamic = "force-dynamic";

import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import { getOwnWinnerClaims } from "@/lib/winnerClaims/service.server";
import { getUserProfileData } from "@/lib/profile/getUserProfileData";
import { enrichOwnWinnerClaims } from "@/lib/profile/profileWinSummary";
import { redirect } from "next/navigation";
import { ProfileWinsList } from "../ProfileHistoryLists";

const PATH = "/my-profile/winnings";

export default async function MyWinsPage() {
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${PATH}`);
  }
  if (sessionState.status === "restricted") {
    redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  }
  if (sessionState.status === "dependency_unavailable") {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10 text-white">
        <BackButton href="/" label="Home" />
        <p role="status" className="rounded-2xl border border-white/10 bg-black/70 p-8 text-center">Winner Claims are temporarily unavailable.</p>
      </main>
    );
  }

  const [result, profile] = await Promise.all([
    getOwnWinnerClaims(sessionState.session).catch(() => null),
    getUserProfileData(sessionState.session.discord_user_id).catch(() => null),
  ]);
  const enrichedWins = enrichOwnWinnerClaims(
    result?.items ?? null,
    profile?.submissions ?? [],
  );
  const completedWins = enrichedWins?.filter((claim) => claim.status !== "unclaimed") ?? null;
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 text-white">
      <BackButton href="/" label="Home" />
      <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-dark)]">My Wins</h1>
      <ProfileWinsList winnings={completedWins} />
    </main>
  );
}
