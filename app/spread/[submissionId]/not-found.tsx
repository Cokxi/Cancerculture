import Link from "next/link";
import BackButton from "@/app/components/ui/BackButton";

export default function CommunityFeedDetailNotFound() {
  return (
    <div className="min-h-screen bg-orange-background text-white">
      <BackButton href="/spread" label="The Spread" />
      <main className="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
        <h1 className="font-['Permanent_Marker'] text-3xl text-[var(--orange-main)] sm:text-4xl">
          Meme unavailable
        </h1>
        <p className="mt-4 text-sm leading-6 text-white/65 sm:text-base">
          This meme is not available in The Spread.
        </p>
        <Link
          href="/spread"
          className="mt-8 inline-flex min-h-11 items-center justify-center rounded-full border border-white/20 bg-black/45 px-5 py-2 font-semibold text-white transition hover:border-orange-300/60 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange-main)]"
        >
          Return to The Spread
        </Link>
      </main>
    </div>
  );
}
