export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import CoinLaunchDisplay from "./components/CoinLaunchDisplay";
import CycleHud from "@/app/components/CycleHud";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import HomeInfoBlocks from "@/app/components/homepageInfoBlocks/HomeInfoBlocks";
import HomeMenu from "@/app/components/navigation/HomeMenu";
import { getPrimaryCoinLaunch } from "@/lib/coinLaunches/getActiveCoinLaunches";
import { processDueCycleTransitions } from "@/lib/cycles/phaseAutomation";
import { getActiveHomepageInfoBlocks } from "@/lib/homepageInfoBlocks/data.server";
import { getHomeDesktopNavigationItems } from "@/lib/navigation/homeNavigation";

const desktopNavigationItems = getHomeDesktopNavigationItems();

function CycleHudFallback() {
  return (
    <div
      className="home-hero__hud-fallback pointer-events-none w-full"
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
    <section
      data-home-section="coin-launch"
      className="pointer-events-none flex w-full max-w-[900px] justify-center"
    >
      <div className="pointer-events-auto w-full max-w-[760px]">
        <CoinLaunchDisplay launch={launch} />
      </div>
    </section>
  ) : null;
}

export default function Home() {
  const transitionPromise = processDueCycleTransitions();
  const launchPromise = getPrimaryCoinLaunch();
  const infoBlocksPromise = getActiveHomepageInfoBlocks();

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

      <div className="mt-3 hidden w-full justify-center md:flex">
        <div className="link-container max-w-[780px]">
          <nav className="link-bar" aria-label="Primary navigation">
            {desktopNavigationItems.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                className={
                  item.id === "info"
                    ? "cursor-pointer rounded-sm outline-none transition-colors hover:text-orange-200 focus-visible:ring-2 focus-visible:ring-orange-300 active:text-orange-100"
                    : "cursor-pointer"
                }
              >
                {item.label.toUpperCase()}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="h-14 md:hidden" aria-hidden />

      <div data-home-stack className="home-page-layout">
        <div data-home-hero className="home-hero">
          <section
            data-home-section="cycle"
            className="home-hero__hud"
          >
            <Suspense fallback={<CycleHudFallback />}>
              <HomeCycleHud transitionPromise={transitionPromise} />
            </Suspense>
          </section>

          <section
            data-home-section="characters"
            className="home-hero__characters"
          >
            <div className="home-hero__character">
              <DiscordCellAnimated />
            </div>

            <div className="home-hero__character">
              <TelegramCellAnimated />
            </div>
          </section>

          <section
            data-home-section="brand"
            className="home-hero__brand"
          >
            <div className="w-full animate-breathe">
              <Image
                src="https://cdn.cancerculture.fun/webp/logo/logo.webp"
                alt="CancerCulture"
                width={900}
                height={260}
                className="h-auto w-full object-contain transition-transform"
              />
            </div>
          </section>
        </div>

        <div data-home-dynamic className="home-dynamic-content">
          <Suspense fallback={null}>
            <HomePrimaryCoinLaunch launchPromise={launchPromise} />
          </Suspense>

          <section
            id="info"
            data-home-section="info"
            className="home-info-section scroll-mt-24 md:scroll-mt-28"
          >
            <Suspense fallback={null}>
              <HomeInfoBlocks
                infoBlocksPromise={infoBlocksPromise}
              />
            </Suspense>
          </section>
        </div>
      </div>

    </main>
  );
}
