import ContractAddress from "./components/ContractAddress";
import { getTeamMember } from "@/lib/auth/guards";
import Image from "next/image";
import Link from "next/link";
import DiscordCellAnimated from "./components/DiscordCellAnimated";
import TelegramCellAnimated from "./components/TelegramCellAnimated";
import { getContractAddress } from "@/lib/config/getContractAddress";
import WalletAddressBox from "@/app/components/WalletAddressBox";


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
    <img src="/TEST-v7.png" alt="" aria-hidden />
    <img src="/TEST-v7.png" alt="" aria-hidden />
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
    justify-center
    gap-3 sm:gap-6
    relative
  "
>



  {/* CELLS (GIMMICK) */}
  <div
  className="
    flex items-center justify-center
    gap-[-20px] sm:gap-6 lg:gap-14
    opacity-85
    mb-[-0.5rem] sm:mb-0
  "
>


    <div className="scale-[0.38] sm:scale-[0.65] lg:scale-[0.75] overflow-visible -mr-20 sm:mr-0">
      <DiscordCellAnimated />

    </div>

    <div className="scale-[0.38] sm:scale-[0.65] lg:scale-[0.75] overflow-visible -mr-20 sm:mr-0">
      <TelegramCellAnimated />
    </div>
  </div>

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
        CancerCulture is a community-driven charity memecoin that highlights
        the toxic nature of the memecoin space. The name does not refer to
        cancer as a disease, but symbolically to unhealthy, irrational, or
        unnecessary behaviors we knowingly keep.
      </p>

      <p>
        The project is powered by its community. An ongoing competition
        distributes 50% of creator rewards back to the community across
        multiple rounds, keeping the culture alive through participation.
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
        CancerCulture runs as an ongoing competition across multiple rounds.
In each round, participants can upload one image representing their personal “cancer” and cast one vote, voting for your own submission is not allowed.
      </p>

      <p>
        No wallet connection is required. To prevent bots and fake votes, users verify via Discord before uploading or voting. All uploads and votes are anonymous, with no accounts, profiles, or visible identities during a round.
      </p>

      <p>
        When a round ends, 100% of that round’s rewards are claimed immediately, with 50% going to the winner.
      </p>

      <p>
        Winners choose whether to keep, donate, or split their prize. Those who donate at least 1% appear on the Wall of Fame; others on the Wall of Shame.
      </p>

      <p>
        Whatever the winner decides, the creator mirror the exact same decision for their remaining 50%, including donation amount and charity.
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
