export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import ContractAddress from "./components/ContractAddress";
import CycleHud from "@/app/components/CycleHud";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import WalletAddressBox from "@/app/components/WalletAddressBox";
import { requireSession } from "@/lib/auth/requireSession";
import { getTeamMember } from "@/lib/auth/guards";
import { getContractAddress } from "@/lib/config/getContractAddress";
import { getPumpFunUrl } from "@/lib/config/getPumpFunUrl";

export default async function Home() {
  let isTeamMember = false;

  try {
    await getTeamMember();
    isTeamMember = true;
  } catch {}

  let isLoggedIn = false;

  try {
    await requireSession();
    isLoggedIn = true;
  } catch {}

  const [contractAddress, pumpFunUrl] = await Promise.all([
    getContractAddress(),
    getPumpFunUrl(),
  ]);

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
            <a href="/vote">VOTE</a>
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

        <a
          href={pumpFunUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="
            group relative animate-breathe -translate-y-2 transition-transform
            hover:animate-none hover:scale-[1.03]
            active:scale-[0.98] sm:translate-y-0
          "
          aria-label="Open CancerCulture on Pump.fun"
        >
          <span
            className="
              pointer-events-none absolute left-0 top-1/2 z-20 hidden
              -translate-x-[105%] -translate-y-1/2 scale-90 opacity-0
              transition-all duration-1500 ease-out
              group-hover:scale-100 group-hover:opacity-100 sm:block
            "
          >
            <Image
              src="https://cdn.cancerculture.fun/webp/icons/pump.V1.webp"
              alt=""
              width={60}
              height={60}
              className="h-10 w-10 object-contain drop-shadow-[0_4px_0_rgba(0,0,0,0.6)] sm:h-14 sm:w-14"
            />
          </span>

          <span
            className="
              pointer-events-none absolute right-0 top-1/2 z-20 hidden
              translate-x-[105%] -translate-y-1/2 scale-90 opacity-0
              transition-all duration-1500 ease-out
              group-hover:scale-100 group-hover:opacity-100 sm:block
            "
          >
            <Image
              src="https://cdn.cancerculture.fun/webp/icons/pump.V1.webp"
              alt=""
              width={60}
              height={60}
              className="h-10 w-10 object-contain drop-shadow-[0_4px_0_rgba(0,0,0,0.6)] sm:h-14 sm:w-14"
            />
          </span>

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
        </a>

        <div className="pointer-events-none absolute inset-x-0 bottom-[-1.25rem] z-20 hidden justify-center md:flex">
          <div className="pointer-events-auto">
            <ContractAddress
              address={contractAddress}
              desktopVariant="centered"
            />
          </div>
        </div>
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
      <li>1 vote</li>
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

      <div className="relative mx-auto max-w-6xl px-6 pb-32 pt-16">
        <div
          className="
            grid grid-cols-1 items-start justify-center gap-20
            lg:grid-cols-[minmax(320px,380px)_220px_minmax(320px,380px)]
          "
        >
          <WalletAddressBox
            label="REWARD WALLET 80%"
            address="HaHu8HiA7FZb7EaaFEop7FxJnSbS5BUq9Q54g7EKrRCt"
          />

          <div aria-hidden className="h-full" />

          <WalletAddressBox
            label="MARKETING WALLET 20%"
            address="26univYjGYH6HRoRQnyTJj7X1wvCyVrFF1K9oHrGQGoE"
          />
        </div>
      </div>

      <div className="md:hidden">
        <ContractAddress address={contractAddress} />
      </div>

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
