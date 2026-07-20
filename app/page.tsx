export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import CoinLaunchDisplay from "./components/CoinLaunchDisplay";
import CycleHud from "@/app/components/CycleHud";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import GlobalAccount from "@/app/components/auth/GlobalAccount";
import HomeMenu from "@/app/components/navigation/HomeMenu";
import { getPrimaryCoinLaunch } from "@/lib/coinLaunches/getActiveCoinLaunches";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";
import { getHomeDesktopNavigationItems } from "@/lib/navigation/homeNavigation";

const HOME_PERF_PREFIX = "[HOME_PERF]";
const desktopNavigationItems = getHomeDesktopNavigationItems();

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

      <HomeMenu />

      <div className="fixed right-3 top-[74px] z-[70] sm:right-5">
        <Suspense
          fallback={
            <div
              className="h-11 w-11 animate-pulse rounded-full border border-orange-500/30 bg-black/80"
              aria-label="Account loading"
            />
          }
        >
          <GlobalAccount />
        </Suspense>
      </div>

      <div className="mt-3 hidden w-full justify-center md:flex">
        <div className="link-container max-w-[780px]">
          <nav className="link-bar" aria-label="Primary navigation">
            {desktopNavigationItems.map((item) => (
              <Link key={item.id} href={item.href} className="cursor-pointer">
                {item.label.toUpperCase()}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="h-14 md:hidden" aria-hidden />

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

    </main>
  );
}
