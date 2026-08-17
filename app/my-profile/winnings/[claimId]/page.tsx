export const dynamic = "force-dynamic";

import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import { getOwnWinnerClaim, WinnerClaimError } from "@/lib/winnerClaims/service.server";
import { notFound, redirect } from "next/navigation";
import WinnerClaimClient from "./WinnerClaimClient";

const CLAIM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export default async function WinnerClaimPage({
  params,
}: {
  params: Promise<{ claimId: string }>;
}) {
  const { claimId } = await params;
  if (!CLAIM_ID_PATTERN.test(claimId)) notFound();

  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${encodeURIComponent(`/my-profile/winnings/${claimId}`)}`);
  }
  if (sessionState.status === "restricted") {
    redirect(`/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`);
  }
  if (sessionState.status === "dependency_unavailable") {
    return <main className="mx-auto max-w-2xl px-4 py-16 text-white">Winner Claim is temporarily unavailable.</main>;
  }

  let result;
  try {
    result = await getOwnWinnerClaim(sessionState.session, claimId);
  } catch (error) {
    if (error instanceof WinnerClaimError && error.status === 404) notFound();
    throw error;
  }

  return (
    <>
      <BackButton href="/my-profile" label="My Profile" />
      <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 text-white">
        <WinnerClaimClient claim={result.claim} databaseTime={result.databaseTime} />
      </main>
    </>
  );
}
