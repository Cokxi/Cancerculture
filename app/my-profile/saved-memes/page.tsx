import BackButton from "@/app/components/ui/BackButton";
import { getSessionState } from "@/lib/auth/sessionState";
import { getOwnSavedMemes } from "@/lib/savedMemes/service.server";
import { redirect } from "next/navigation";
import SavedMemesClient from "./SavedMemesClient";

const PATH = "/my-profile/saved-memes";

export default async function SavedMemesPage() {
  const sessionState = await getSessionState();
  if (sessionState.status === "anonymous") {
    redirect(`/api/auth/discord/login?state=${PATH}`);
  }
  if (sessionState.status === "restricted") {
    redirect(
      `/banned?code=${sessionState.reason === "discord_banned" ? "DISCORD_BANNED" : "WEBSITE_BANNED"}`,
    );
  }

  const initialPage =
    sessionState.status === "authenticated"
      ? await getOwnSavedMemes({
          sessionId: sessionState.session.session_id,
          limit: 24,
        }).catch(() => null)
      : null;

  return (
    <>
      <BackButton href="/" label="Home" />
      <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-16 text-white sm:px-6">
        <header className="mx-auto max-w-2xl text-center">
          <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-dark)] sm:text-5xl">
            My Saved Memes
          </h1>
        </header>

        {initialPage ? (
          <SavedMemesClient initialPage={initialPage} />
        ) : (
          <div role="status" className="mx-auto mt-10 max-w-xl rounded-2xl border border-white/10 bg-black/60 p-6 text-center text-white/70">
            Saved memes are temporarily unavailable. Please try again shortly.
          </div>
        )}
      </main>
    </>
  );
}
