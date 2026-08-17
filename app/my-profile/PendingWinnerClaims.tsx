import ClaimCountdown from "@/app/components/winners/ClaimCountdown";
import type { OwnWinnerClaimSummary } from "@/lib/winnerClaims/service.server";
import Link from "next/link";

export default function PendingWinnerClaims({
  items,
  databaseTime,
}: {
  items: OwnWinnerClaimSummary[] | null;
  databaseTime: string | null;
}) {
  const pending = items?.filter((claim) => claim.status === "unclaimed") ?? [];
  if (pending.length === 0) return null;

  return (
    <section className="rounded-2xl border border-orange-300/35 bg-orange-950/20 p-5 sm:p-6" aria-labelledby="pending-wins-title">
      <h2 id="pending-wins-title" className="text-2xl font-[Permanent_Marker] text-[var(--orange-dark)]">
        Claim your win
      </h2>
      <div className="mt-5 space-y-3">
        {pending.map((claim) => (
          <article key={claim.claimId} className="rounded-xl border border-white/10 bg-black/35 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-semibold text-white">Cycle #{claim.cycleNumber ?? claim.cycleId} · Submission #{claim.submissionId}</p>
                <p className="mt-1 text-sm text-white/65">
                  {claim.payoutChoice === "keep" ? "Keep 100%" : claim.payoutChoice === "donate" ? `Donate 100%${claim.charity ? ` to ${claim.charity}` : ""}` : `Keep ${claim.splitPercent}% / donate ${100 - (claim.splitPercent ?? 0)}%${claim.charity ? ` to ${claim.charity}` : ""}`}
                </p>
              </div>
              <span className="rounded-full border border-orange-300/30 bg-orange-950/25 px-3 py-1 text-xs text-orange-100">Unclaimed</span>
            </div>
            {claim.deadlineAt ? (
              <div className="mt-3 rounded-lg border border-orange-300/20 bg-black/25 p-3 text-sm text-orange-100">
                <div>Time remaining: <ClaimCountdown deadlineAt={claim.deadlineAt} databaseTime={databaseTime} className="font-mono font-semibold" /></div>
                <div className="mt-1 text-xs text-white/50">Claim by {new Date(claim.deadlineAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</div>
              </div>
            ) : null}
            <Link href={`/my-profile/winnings/${claim.claimId}`} className="mt-4 inline-flex min-h-11 items-center rounded-lg border border-orange-300/35 px-4 py-2 text-sm font-semibold text-orange-100 outline-none hover:bg-orange-950/25 focus-visible:ring-2 focus-visible:ring-orange-300">
              Claim win
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
