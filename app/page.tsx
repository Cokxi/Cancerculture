export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import CoinLaunchDisplay from "./components/CoinLaunchDisplay";
import CycleHud from "@/app/components/CycleHud";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { getTeamMemberForDiscordUserId } from "@/lib/auth/guards";
import { getPrimaryCoinLaunch } from "@/lib/coinLaunches/getActiveCoinLaunches";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";

const HOME_PERF_PREFIX = "[HOME_PERF]";

function startHomeTimer(label: string) {
  const startedAt = performance.now();

  return () => {
    console.log(
      `${HOME_PERF_PREFIX} ${label}: ${(
        performance.now() - startedAt
      ).toFixed(1)}ms`
    );
  };
}

async function timeHomeAsync<T>(
  label: string,
  callback: () => Promise<T>
) {
  const startedAt = performance.now();

  try {
    return await callback();
  } finally {
    console.log(
      `${HOME_PERF_PREFIX} ${label}: ${(
        performance.now() - startedAt
      ).toFixed(1)}ms`
    );
  }
}

export default async function Home() {
  const endHomeTimer = startHomeTimer(
    "home page server render total (Home component before child RSC render)"
  );

  await timeHomeAsync("home due cycle transitions", () =>
    processDueCycleTransitions()
  );

  let isLoggedIn = false;
  let discordUserId: string | null = null;

  try {
    const session = await timeHomeAsync("home auth/session loading", () =>
      requireSession()
    );
    discordUserId = session.discord_user_id;
    isLoggedIn = true;
  } catch (error) {
    const status = getAuthErrorStatus(error);

    if (status !== null && status >= 500) {
      console.error("[ADMIN_AUTH] home session check unavailable", error);
    } else if (status === null) {
      throw error;
    }
  }

  let isTeamMember = false;

  if (discordUserId) {
    try {
      await timeHomeAsync("home auth/team member loading", () =>
        getTeamMemberForDiscordUserId(discordUserId)
      );
      isTeamMember = true;
    } catch (error) {
      const status = getAuthErrorStatus(error);

      if (status !== null && status >= 500) {
        console.error(
          "[ADMIN_AUTH] home team-member check unavailable; menu will retry on the next server render",
          error
        );
      } else if (status === null) {
        throw error;
      }
    }
  } else {
    console.log(
      `${HOME_PERF_PREFIX} home auth/team member loading: skipped (no session)`
    );
  }

  let primaryCoinLaunch = null;

  try {
    primaryCoinLaunch = await timeHomeAsync(
      "home primary coin launch loading",
      () => getPrimaryCoinLaunch()
    );
  } catch (error) {
    console.error("[COIN_LAUNCHES] home launch loading failed", error);
  }

  console.log(
    `${HOME_PERF_PREFIX} home submissions loading: not used by home route`
  );
  console.log(
    `${HOME_PERF_PREFIX} home user profile loading: not used by home route`
  );
  console.log(
    `${HOME_PERF_PREFIX} home user vote state / vote counts loading: not used by home route`
  );
  console.log(
    `${HOME_PERF_PREFIX} home social links loading: not used by home route`
  );
  console.log(
    `${HOME_PERF_PREFIX} home cycle history / wall preview loading: not used by home route`
  );

  endHomeTimer();

  return (
    <main className="relative w-full bg-orange-background text-white">
      {isTeamMember && (
        <div className="fixed left-6 top-20 z-30">
          <Link
            href="/admin"
            className="rounded-md px-4 py-2 text-sm transition hover:bg-black"
          >
            Moderation
          </Link>
        </div>
      )}

      <div className="ticker-wrapper">
        <div className="ticker-track">
          <div className="ticker-text">
            CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL
            - BE PART OF THE CULTURE - CREATE MEMES - UPLOAD - VOTE - WIN -
            DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE -
          </div>

          <div className="ticker-text" aria-hidden>
            CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL
            - BE PART OF THE CULTURE - CREATE MEMES - UPLOAD - VOTE - WIN -
            DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE -
          </div>
        </div>
      </div>

      <div className="mt-4 flex w-full justify-center">
        <div className="link-container">
          <nav className="link-bar">
            <a href="#about">ABOUT</a>
            <a href="/upload">UPLOAD</a>
            <a href="/submissions">SUBMISSIONS</a>
            <a href="/faq">FAQ</a>
            <a href="/rules">RULES</a>
            <a href="/wall/fame">WALL OF FAME</a>
            <a href="/wall/shame">WALL OF SHAME</a>
          </nav>
        </div>
      </div>

      <section
        className="
          relative flex min-h-[70vh] max-h-[900px] flex-col items-center
          justify-start gap-3 pt-6 sm:min-h-screen sm:justify-center sm:gap-6 sm:pt-0
        "
      >
        <div
          className="
            relative z-10 mb-[-0.5rem] flex items-center justify-center
            gap-[-20px] opacity-85 sm:mb-0 sm:gap-6 lg:gap-14
          "
        >
          <div className="scale-[0.38] overflow-visible -mr-20 sm:mr-0 sm:scale-[0.65] lg:scale-[0.75]">
            <DiscordCellAnimated />
          </div>

          <div className="scale-[0.38] overflow-visible -ml-20 sm:ml-0 sm:scale-[0.65] lg:scale-[0.75]">
            <TelegramCellAnimated />
          </div>
        </div>

        <CycleHud />

        <div className="relative animate-breathe -translate-y-2 sm:translate-y-0">
          <Image
            src="https://cdn.cancerculture.fun/webp/logo/logo.webp"
            alt="CancerCulture"
            width={900}
            height={260}
            className="
              h-auto max-h-[32vh] w-[min(900px,92vw)] object-contain transition-transform
              sm:max-h-[22vh] sm:w-[min(900px,80vw)]
            "
          />
        </div>

        {primaryCoinLaunch ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-[-1.25rem] z-20 flex justify-center">
            <div className="pointer-events-auto">
              <CoinLaunchDisplay launch={primaryCoinLaunch} />
            </div>
          </div>
        ) : null}
      </section>

      <section id="about" className="relative w-full">
        <section className="relative flex w-full justify-center py-32">
          <div className="orange-info-box orange-info-box--compact">
  <div className="max-w-[520px] mx-auto text-center">
    <h3 className="orange-box-title">ABOUT</h3>

    <p>
      CancerCulture is a community-driven meme competition built around creativity and chaos.
    </p>

    <p>
      The name represents how memes and narratives spread, fast, irrational, and everywhere.
    </p>

    <p>
      Each cycle is its own competition. No algorithms, no hidden rules, just memes and vibes.
    </p>

    <p>
      Create something, upload it, and let the community decide.
    </p>

    <p>Win or lose, you&apos;re part of the culture.</p>
  </div>
</div>
        </section>

        <section className="relative flex w-full justify-center py-24">
          <div className="orange-info-box orange-info-box--compact">
  <div className="max-w-[520px] mx-auto text-center">
    <h3 className="orange-box-title">HOW IT WORKS</h3>

    <p>Each cycle is a standalone meme competition.</p>

    <p>You get:</p>
    <ul className="pl-5 list-disc inline-block text-left">
      <li>1 submission</li>
      <li>2 votes</li>
    </ul>

    <p className="mt-4">
      No self-voting. Submissions stay anonymous during the cycle.
    </p>

    <p>When it ends, votes decide the winners.</p>

    <p>Rewards are paid in Solana and split if needed.</p>

    <p>Winners choose: keep it, donate, or split.</p>
  </div>
</div>
        </section>
      </section>

      {isLoggedIn && (
        <Link
          href="/cycle-history"
          className="
            fixed bottom-6 left-6 z-50 hidden items-center justify-center
            rounded-lg border border-orange-500/30 bg-black/75 px-5 py-3
            text-sm font-[var(--font-marker)] text-orange-400 shadow-lg shadow-black/30
            transition-all hover:bg-black/90 hover:scale-105 active:scale-95 md:flex
          "
        >
          Cycle History
        </Link>
      )}

      {isLoggedIn && (
        <Link
          href="/my-profile"
          className="
            fixed bottom-6 right-6 z-50 hidden items-center justify-center
            rounded-lg border border-orange-500/30 bg-black/75 px-5 py-3
            text-sm font-[var(--font-marker)] text-orange-400 shadow-lg shadow-black/30
            transition-all hover:bg-black/90 hover:scale-105 active:scale-95 md:flex
          "
        >
          My Profile
        </Link>
      )}

      {isLoggedIn && (
        <>
          <Link
            href="/cycle-history"
            className="
              fixed bottom-4 left-3 z-50 flex items-center justify-center rounded-lg border border-orange-500/40
              bg-black/80 px-3 py-2 text-sm font-[var(--font-marker)] text-orange-400
              shadow-lg shadow-black/40 backdrop-blur-sm transition-all hover:bg-black/90 active:scale-95
              md:hidden
            "
          >
            Cycle History
          </Link>

          <Link
            href="/my-profile"
            className="
              fixed bottom-4 right-3 z-50 flex items-center justify-center rounded-lg border border-orange-500/40
              bg-black/80 px-3 py-2 text-sm font-[var(--font-marker)] text-orange-400
              shadow-lg shadow-black/40 backdrop-blur-sm transition-all hover:bg-black/90 active:scale-95
              md:hidden
            "
          >
            My Profile
          </Link>
        </>
      )}
    </main>
  );
}
