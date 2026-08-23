export const dynamic = "force-dynamic";

import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import { getUserProfileData } from "@/lib/profile/getUserProfileData";
import { redirect } from "next/navigation";
import { ProfileVotesList } from "../ProfileHistoryLists";

const PATH = "/my-profile/votes";

export default async function MyVotesPage() {
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
        <p role="status" className="rounded-2xl border border-white/10 bg-black/70 p-8 text-center">Votes are temporarily unavailable.</p>
      </main>
    );
  }

  const profile = await getUserProfileData(sessionState.session.discord_user_id);
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 text-white">
      <BackButton href="/" label="Home" />
      <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-dark)]">My Votes</h1>
      <ProfileVotesList votes={profile.votes} />
    </main>
  );
}
