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

const desktopNavigationItems = getHomeDesktopNavigationItems();

function CycleHudFallback() {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      aria-hidden
    />
  );
}

async function HomeCycleHud({
  transitionPromise,
}: {
  transitionPromise: ReturnType<
    typeof processDueCycleTransitions
  >;
}) {
  await transitionPromise;
  return <CycleHud />;
}

async function HomePrimaryCoinLaunch({
  launchPromise,
}: {
  launchPromise: ReturnType<typeof getPrimaryCoinLaunch>;
}) {
  let launch;

  try {
    launch = await launchPromise;
  } catch {
    console.error("[COIN_LAUNCHES] home launch loading failed");
    return null;
  }

  return launch ? (
    <div className="pointer-events-none absolute inset-x-0 bottom-[-1.25rem] z-20 flex justify-center">
      <div className="pointer-events-auto">
        <CoinLaunchDisplay launch={launch} />
      </div>
    </div>
  ) : null;
}

export default function Home() {
  const transitionPromise = processDueCycleTransitions();
  const launchPromise = getPrimaryCoinLaunch();

  return (
    <main className="relative isolate w-full bg-orange-background text-white">
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
          relative isolate flex min-h-[calc(100svh-7rem)] flex-col items-center
          justify-start gap-3 pb-8 pt-6
          sm:min-h-screen sm:max-h-[900px] sm:justify-center sm:gap-6 sm:pb-0 sm:pt-0
        "
      >
        <div className="relative w-full sm:static">
          <div
            className="
              relative z-0 mb-[-0.5rem] flex w-full items-center justify-center
              gap-0 opacity-85 sm:mb-0 sm:gap-6 lg:gap-14
            "
          >
            <div className="w-[min(42vw,152px)] overflow-visible sm:w-[260px] lg:w-[300px]">
              <DiscordCellAnimated />
            </div>

            <div className="w-[min(42vw,152px)] overflow-visible sm:w-[260px] lg:w-[300px]">
              <TelegramCellAnimated />
            </div>
          </div>

          <Suspense fallback={<CycleHudFallback />}>
            <HomeCycleHud
              transitionPromise={transitionPromise}
            />
          </Suspense>
        </div>

        <div className="relative z-20 -translate-y-2 animate-breathe sm:translate-y-0">
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

        <Suspense fallback={null}>
          <HomePrimaryCoinLaunch
            launchPromise={launchPromise}
          />
        </Suspense>
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
