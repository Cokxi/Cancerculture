export const dynamic = "force-dynamic";


import ContractAddress from "./components/ContractAddress";
import { getTeamMember } from "@/lib/auth/guards";
import Image from "next/image";
import Link from "next/link";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import { getContractAddress } from "@/lib/config/getContractAddress";
import WalletAddressBox from "@/app/components/WalletAddressBox";
import CycleHud from "@/app/components/CycleHud";


export default async function Home() {
  let isTeamMember = false;

  try {
    await getTeamMember();
    isTeamMember = true;
  } catch {}

  const contractAddress = await getContractAddress();

  return (
    <main className="relative w-full bg-orange-background text-white">

      {/* 🛡️ TEAM BUTTON */}
      {isTeamMember && (
        <div className="fixed top-20 left-6 z-30">
          <Link
            href="/admin"
            className="px-4 py-2 text-sm rounded-md hover:bg-black transition"
          >
            🛡️ Moderation
          </Link>
        </div>
      )}

{/* TICKER */}
<div className="ticker-wrapper">
  <div className="ticker-track">
    <div className="ticker-text">
      CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE - 
      CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE -
              </div>

    <div className="ticker-text" aria-hidden>
      CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE - 
      CREATE MEMES - UPLOAD - VOTE - WIN - DONATE OR NOT - CHILL & SHILL - BE PART OF THE CULTURE -
          </div>
  </div>
</div>


{/* LINK BAR */}
<div className="w-full flex justify-center mt-4">
  <div className="link-container">
  <nav className="link-bar">
  <a href="#about">ABOUT</a>
  <a href="/upload">UPLOAD</a>
  <a href="/vote">VOTE</a>

  {/* Desktop labels */}
  <span className="hidden sm:flex gap-8">
    <a href="/faq">FAQ / RULES</a>
    <a href="/wall/fame">WALL OF FAME</a>
    <a href="/wall/shame">WALL OF SHAME</a>
    
  </span>

  {/* Mobile labels */}
<span className="flex sm:hidden w-full justify-center mt-2">
  <span className="flex gap-8">
    <a href="/faq">FAQ</a>
    <a href="/wall/fame">FAME</a>
    <a href="/wall/shame">SHAME</a>
  </span>
</span>

</nav>

  </div>
</div>




      {/* HERO */}
<section
  className="
    min-h-screen
    max-h-[900px]
    flex
    flex-col
    items-center
    justify-start sm:justify-center
    pt-6 sm:pt-0
    gap-3 sm:gap-6
    relative
  "
>


  {/* CELLS (GIMMICK) */}
  <div
  className="
    relative z-10
    flex items-center justify-center
    gap-[-20px] sm:gap-6 lg:gap-14
    opacity-85
    mb-[-0.5rem] sm:mb-0
  "
>


    <div className="scale-[0.38] sm:scale-[0.65] lg:scale-[0.75] overflow-visible -mr-20 sm:mr-0">
      <DiscordCellAnimated />

    </div>

    <div className="scale-[0.38] sm:scale-[0.65] lg:scale-[0.75] overflow-visible -ml-20 sm:ml-0">
      <TelegramCellAnimated />
    </div>
  </div>
<CycleHud />

  {/* LOGO */}
  <Link
    href="/about"
    className="
      animate-breathe
      hover:animate-none
      hover:scale-[1.03]
      active:scale-[0.98]
      transition-transform
    "
  >
    <Image
  src="/logo/cancerculture-logo-v2.png"
  alt="CancerCulture"
  width={900}
  height={260}
  className="
    w-[min(900px,80vw)]
    max-h-[22vh]
    h-auto
    object-contain
    transition-transform
  "
/>

  </Link>

</section>

{/* ABOUT + HOW IT WORKS WRAPPER */}
<section id="about" className="relative w-full">

  {/* ABOUT BOX */}
  <section className="relative w-full flex justify-center py-32">
    <div className="content-container">
      <div className="orange-info-box orange-info-box--compact max-w-[520px]">

        <h3 className="orange-box-title">ABOUT</h3>

      <p>
        CancerCulture is a community driven charity meme competition built around the chaotic nature of the memecoin space.
        The name does not refer to cancer as a disease.
        It symbolically describes the irrational, fast spreading culture of memes, trends, and narratives that define the space.
      </p>

      <p>
        Instead of fighting that chaos, CancerCulture turns it into a game:
        create original memes, upload them, and let the community decide what survives.
      </p>  
      <p>  
        An ongoing competition distributes 50% of creator rewards back to the community across multiple rounds, keeping the culture alive through participation.
      </p>

      <p>
        Be creative. Upload. Vote. Chill + shill.
      </p>

      <a href="/about" className="orange-box-link">
        View more →
      </a>
    </div>
  </div>
</section>

{/* HOW IT WORKS BOX */}
  <section className="relative w-full flex justify-center py-24">
    <div className="content-container">
      <div className="orange-info-box orange-info-box--compact">

        <h3 className="orange-box-title">HOW IT WORKS</h3>

      <p>
        CancerCulture runs as an ongoing meme competition across multiple rounds.
      </p>

      <p>
        In each round, participants can upload one original meme and cast one vote.
        Voting for your own submission is not allowed.
      </p>

      <p>
        No wallet connection is required.
        To reduce bots and fake votes, users verify via Discord before uploading or voting.
        All submissions and votes remain anonymous during an active round.
      </p>

      <p>
        When a round ends, 100% of that round’s rewards are claimed immediately, with 50% going to the winning meme creator.
      </p>

      <p>
        Winners choose whether to keep, donate, or split their prize.
        Those who donate at least 1% appear on the Wall of Fame; others on the Wall of Shame.
      </p>

      <p>
        Whatever the winner decides, the creator mirrors the exact same decision for their remaining 50%, including donation amount and charity.
      </p>

      <a href="/faq" className="orange-box-link">
          View more →
        </a>
      </div>
    </div>
  </section>

</section>

{/* WALLET ADDRESSES */}
<div className="relative max-w-6xl mx-auto px-6 pt-16 pb-32">
  <div
    className="
      grid
      grid-cols-1
      lg:grid-cols-[minmax(320px,380px)_220px_minmax(320px,380px)]
      gap-20
      items-start
      justify-center
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

    

      {/* CONTRACT ADDRESS */}
      <ContractAddress address={contractAddress} />

    </main>
  );
}
