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

  const contractAddress = await getContractAddress();

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

            <span className="hidden gap-8 sm:flex">
              <a href="/faq">FAQ / RULES</a>
              <a href="/wall/fame">WALL OF FAME</a>
              <a href="/wall/shame">WALL OF SHAME</a>
            </span>

            <span className="mt-2 flex w-full justify-center sm:hidden">
              <span className="flex gap-8">
                <a href="/faq">FAQ</a>
                <a href="/wall/fame">FAME</a>
                <a href="/wall/shame">SHAME</a>
              </span>
            </span>
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

        <Link
          href="/about"
          className="
            animate-breathe -translate-y-2 transition-transform
            hover:animate-none hover:scale-[1.03]
            active:scale-[0.98] sm:translate-y-0
          "
        >
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
        </Link>

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
          <div className="content-container">
            <div className="orange-info-box orange-info-box--compact max-w-[520px]">
              <h3 className="orange-box-title">ABOUT</h3>

              <p>
                CancerCulture is a community driven charity meme competition
                built around the chaotic nature of the memecoin space. The name
                does not refer to cancer as a disease. It symbolically
                describes the irrational, fast spreading culture of memes,
                trends, and narratives that define the space.
              </p>

              <p>
                Instead of fighting that chaos, CancerCulture turns it into a
                game: create original memes, upload them, and let the community
                decide what survives.
              </p>

              <p>
                An ongoing competition distributes 50% of creator rewards back
                to the community across multiple rounds, keeping the culture
                alive through participation.
              </p>

              <p>Be creative. Upload. Vote. Chill + shill.</p>

              <a href="/about" className="orange-box-link">
                View more -&gt;
              </a>
            </div>
          </div>
        </section>

        <section className="relative flex w-full justify-center py-24">
          <div className="content-container">
            <div className="orange-info-box orange-info-box--compact">
              <h3 className="orange-box-title">HOW IT WORKS</h3>

              <p>
                CancerCulture runs as an ongoing meme competition across
                multiple rounds.
              </p>

              <p>
                In each round, participants can upload one original meme and
                cast one vote. Voting for your own submission is not allowed.
              </p>

              <p>
                No wallet connection is required. To reduce bots and fake
                votes, users verify via Discord before uploading or voting. All
                submissions and votes remain anonymous during an active round.
              </p>

              <p>
                When a round ends, 100% of that round&apos;s rewards are claimed
                immediately, with 50% going to the winning meme creator.
              </p>

              <p>
                Winners choose whether to keep, donate, or split their prize.
                Those who donate at least 1% appear on the Wall of Fame; others
                on the Wall of Shame.
              </p>

              <p>
                Whatever the winner decides, the creator mirrors the exact same
                decision for their remaining 50%, including donation amount and
                charity.
              </p>

              <a href="/faq" className="orange-box-link">
                View more -&gt;
              </a>
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
        <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 gap-3 md:hidden">
          <Link
            href="/cycle-history"
            className="
              flex items-center justify-center rounded-lg border border-orange-500/30
              bg-black/75 px-4 py-2 text-sm font-[var(--font-marker)] text-orange-400
              shadow-lg shadow-black/30 transition-all hover:bg-black/90 active:scale-95
            "
          >
            Cycle History
          </Link>

          <Link
            href="/my-profile"
            className="
              flex items-center justify-center rounded-lg border border-orange-500/30
              bg-black/75 px-4 py-2 text-sm font-[var(--font-marker)] text-orange-400
              shadow-lg shadow-black/30 transition-all hover:bg-black/90 active:scale-95
            "
          >
            My Profile
          </Link>
        </div>
      )}
    </main>
  );
}
