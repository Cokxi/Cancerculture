export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { hasResolvedTeamCapability } from "@/lib/auth/teamAuthorization";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import { getTeamWinnerClaims, type TeamWinnerClaim } from "@/lib/winnerClaims/service.server";
import UserProfileLink from "../shared/UserProfileLink";
import CopyWalletButton from "./CopyWalletButton";
import WinnerCorrectionControls from "./WinnerCorrectionControls";
import ClaimCountdown from "@/app/components/winners/ClaimCountdown";

function payoutDescription(winner: TeamWinnerClaim) {
  if (winner.payoutChoice === "donate") return `Donate 100%${winner.charity ? ` to ${winner.charity}` : ""}`;
  if (winner.payoutChoice === "split") return `Keep ${winner.splitPercent}% / donate ${100 - (winner.splitPercent ?? 0)}%${winner.charity ? ` to ${winner.charity}` : ""}`;
  return "Keep 100%";
}

function statusDescription(winner: TeamWinnerClaim) {
  if (winner.status === "not_required") return "Donation — no claim required";
  if (winner.status === "unclaimed") return "Unclaimed";
  if (winner.status === "correction_pending") return "Wallet correction pending";
  if (winner.status === "confirmed") return "Claimed";
  if (winner.status === "declined") return "Declined";
  return "Unclaimed — expired";
}

export default async function WinnerLogsPage() {
  const authorization = await requireTeamCapabilityPage("winners.payouts.view", "/admin/logs/winners");
  const canManageCorrections = hasResolvedTeamCapability(authorization, "winners.recipient_corrections.manage");
  const { databaseTime, items: winners } = await getTeamWinnerClaims({
    actorDiscordUserId: authorization.discord_user_id,
    includeCorrections: canManageCorrections,
  });
  const winnersByCycle = new Map<number, TeamWinnerClaim[]>();
  for (const winner of winners) {
    winnersByCycle.set(winner.cycleId, [...(winnersByCycle.get(winner.cycleId) ?? []), winner]);
  }

  return (
    <div>
      <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">Winner Payouts</h1>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/60">Decisions and Claim status are visible immediately. An exact payout Wallet appears only after the winner personally confirms a keep or split Claim.</p>
      {winners.length === 0 ? (
        <p className="mt-6 text-white/60">No finalized winners yet.</p>
      ) : (
        <div className="mt-6 space-y-5">
          {Array.from(winnersByCycle.entries()).map(([cycleId, cycleWinners]) => (
            <details key={cycleId} open className="rounded-xl border border-white/10 bg-black/40 p-5">
              <summary className="cursor-pointer font-semibold text-orange-300">
                Cycle #{cycleWinners[0]?.cycleNumber ?? cycleId}{cycleWinners[0]?.cycleTheme ? ` — ${cycleWinners[0].cycleTheme}` : ""} ({cycleWinners.length} {cycleWinners.length === 1 ? "winner" : "tied winners"})
              </summary>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {cycleWinners.map((winner) => {
                  const label = formatDiscordUserLabel({
                    current_discord_username: winner.currentDiscordUsername,
                    current_discord_handle: winner.currentDiscordHandle,
                    current_display_name: winner.currentDisplayName,
                    current_guild_nickname: winner.currentGuildNickname,
                  });
                  const terminal = ["confirmed", "declined", "not_required"].includes(winner.status);
                  return (
                    <article key={winner.claimId} className="rounded-lg border border-white/10 bg-white/5 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <UserProfileLink discordUserId={winner.discordUserId} label={label || winner.discordUserId} publicProfileId={winner.publicProfileId} />
                          <div className="mt-1 text-xs text-white/45">Submission #{winner.submissionId}</div>
                        </div>
                        <div className="text-right text-sm"><div>{winner.voteCount} votes</div><div className="text-white/55">Prize share: {(winner.winShare * 100).toFixed(2)}%</div></div>
                      </div>
                      <div className="mt-4 rounded-md bg-black/30 p-3 text-sm"><div className="text-xs uppercase tracking-wide text-white/45">Payout choice</div><div className="mt-1 font-semibold text-white">{payoutDescription(winner)}</div></div>
                      <div className="mt-3 rounded-md bg-black/30 p-3 text-sm">
                        <div className="text-xs uppercase tracking-wide text-white/45">Claim status</div>
                        <div className="mt-1 font-semibold text-white">{statusDescription(winner)}</div>
                        {winner.status === "unclaimed" && winner.deadlineAt ? (
                          <div className="mt-2 rounded-md border border-orange-300/20 bg-orange-950/20 p-2 text-xs text-orange-100">
                            <div>Claim time remaining: <ClaimCountdown deadlineAt={winner.deadlineAt} databaseTime={databaseTime} className="font-mono font-semibold" /></div>
                            <div className="mt-1 text-white/50">Deadline: {new Date(winner.deadlineAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</div>
                          </div>
                        ) : null}
                        {winner.confirmedAt ? <div className="mt-1 text-xs text-white/55">Confirmed: {new Date(winner.confirmedAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}</div> : null}
                      </div>
                      {winner.status === "confirmed" && winner.payoutChoice !== "donate" && winner.walletAddress ? (
                        <div className="mt-3"><div className="text-xs uppercase tracking-wide text-white/45">Locked Wallet · {winner.confirmedRecipientSource}</div><div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start"><code className="block min-w-0 flex-1 select-all break-all rounded-md bg-black/40 p-3 text-xs text-green-300">{winner.walletAddress}</code><CopyWalletButton walletAddress={winner.walletAddress} /></div></div>
                      ) : winner.payoutChoice !== "donate" ? (
                        <p className="mt-3 rounded-md bg-black/30 p-3 text-xs text-white/55">{winner.status === "unclaimed" ? "Wallet pending winner confirmation" : "No payout Wallet is exposed for this state"}</p>
                      ) : null}
                      {canManageCorrections && winner.correctionEligible && !terminal ? <WinnerCorrectionControls winner={winner} /> : null}
                    </article>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
