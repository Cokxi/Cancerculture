import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { supabaseAdmin } from "@/lib/db/admin";
import { formatDiscordUserLabel } from "@/lib/discord/formatDiscordUserLabel";
import UserProfileLink from "../shared/UserProfileLink";
import CopyWalletButton from "./CopyWalletButton";

type WinnerRow = {
  cycle_id: number;
  submission_id: number;
  vote_count: number;
  win_share: number;
  wallet_address: string | null;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
};

function getPayoutDescription(winner: WinnerRow) {
  if (winner.payout_choice === "donate") {
    return `Donate 100%${winner.charity ? ` to ${winner.charity}` : ""}`;
  }

  if (winner.payout_choice === "split") {
    const keepPercent = winner.split_percent ?? 0;
    const charityPercent = 100 - keepPercent;

    return `Keep ${keepPercent}% / donate ${charityPercent}%${
      winner.charity ? ` to ${winner.charity}` : ""
    }`;
  }

  return "Keep 100%";
}

export default async function WinnerLogsPage() {
  await requireTeamCapabilityPage(
    "winners.payouts.view",
    "/admin/logs/winners"
  );

  const { data: winnerRows, error } = await supabaseAdmin
    .from("winner_public_profiles")
    .select(
      "cycle_id, submission_id, vote_count, win_share, wallet_address, payout_choice, split_percent, charity"
    )
    .order("cycle_id", { ascending: false });

  if (error) {
    return <div>Failed to load winner payout data.</div>;
  }

  const winners = (winnerRows ?? []) as WinnerRow[];
  const submissionIds = winners.map((winner) => winner.submission_id);
  const cycleIds = Array.from(
    new Set(winners.map((winner) => winner.cycle_id))
  );
  const [{ data: submissions }, { data: cycles }] = await Promise.all([
    submissionIds.length > 0
      ? supabaseAdmin
          .from("submissions")
          .select("id, discord_user_id")
          .in("id", submissionIds)
      : Promise.resolve({ data: [] }),
    cycleIds.length > 0
      ? supabaseAdmin
          .from("voting_cycles")
          .select("id, theme")
          .in("id", cycleIds)
      : Promise.resolve({ data: [] }),
  ]);
  const discordUserIdBySubmissionId = new Map(
    (submissions ?? []).map((submission) => [
      submission.id,
      submission.discord_user_id,
    ])
  );
  const discordUserIds = Array.from(
    new Set(discordUserIdBySubmissionId.values())
  );
  const { data: users } =
    discordUserIds.length > 0
      ? await supabaseAdmin
          .from("user_logs")
          .select(
            "discord_user_id, public_profile_id, current_discord_username, current_discord_handle, current_display_name, current_guild_nickname"
          )
          .in("discord_user_id", discordUserIds)
      : { data: [] };
  const userByDiscordId = new Map(
    (users ?? []).map((user) => [user.discord_user_id, user])
  );
  const themeByCycleId = new Map(
    (cycles ?? []).map((cycle) => [cycle.id, cycle.theme])
  );
  const winnersByCycle = new Map<number, WinnerRow[]>();

  for (const winner of winners) {
    winnersByCycle.set(winner.cycle_id, [
      ...(winnersByCycle.get(winner.cycle_id) ?? []),
      winner,
    ]);
  }

  return (
    <div>
      <h1 className="text-3xl font-[Permanent_Marker] text-[var(--orange-dark)]">
        Winner Payouts
      </h1>

      {winners.length === 0 ? (
        <p className="mt-6 text-white/60">No finalized winners yet.</p>
      ) : (
        <div className="mt-6 space-y-5">
          {Array.from(winnersByCycle.entries()).map(
            ([cycleId, cycleWinners]) => (
              <details
                key={cycleId}
                open
                className="rounded-xl border border-white/10 bg-black/40 p-5"
              >
                <summary className="cursor-pointer font-semibold text-orange-300">
                  Cycle #{cycleId}
                  {themeByCycleId.get(cycleId)
                    ? ` - ${themeByCycleId.get(cycleId)}`
                    : ""}{" "}
                  ({cycleWinners.length}{" "}
                  {cycleWinners.length === 1 ? "winner" : "tied winners"})
                </summary>

                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  {cycleWinners.map((winner) => {
                    const discordUserId =
                      discordUserIdBySubmissionId.get(
                        winner.submission_id
                      ) ?? null;
                    const user = discordUserId
                      ? userByDiscordId.get(discordUserId)
                      : null;

                    return (
                      <div
                        key={winner.submission_id}
                        className="rounded-lg border border-white/10 bg-white/5 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            {discordUserId ? (
                              <UserProfileLink
                                discordUserId={discordUserId}
                                label={
                                  user
                                    ? formatDiscordUserLabel(user)
                                    : discordUserId
                                }
                                publicProfileId={
                                  user?.public_profile_id ?? null
                                }
                              />
                            ) : (
                              <strong>Unknown User</strong>
                            )}
                            <div className="mt-1 text-xs text-white/45">
                              Submission #{winner.submission_id}
                            </div>
                          </div>

                          <div className="text-right text-sm">
                            <div>{winner.vote_count} votes</div>
                            <div className="text-white/55">
                              Prize share:{" "}
                              {(winner.win_share * 100).toFixed(2)}%
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 rounded-md bg-black/30 p-3 text-sm">
                          <div className="text-xs uppercase tracking-wide text-white/45">
                            Payout choice
                          </div>
                          <div className="mt-1 font-semibold text-white">
                            {getPayoutDescription(winner)}
                          </div>
                        </div>

                        {winner.payout_choice !== "donate" ? (
                          <div className="mt-3">
                            <div className="text-xs uppercase tracking-wide text-white/45">
                              Wallet
                            </div>
                            {winner.wallet_address ? (
                              <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-start">
                                <code className="block min-w-0 flex-1 select-all break-all rounded-md bg-black/40 p-3 text-xs text-green-300">
                                  {winner.wallet_address}
                                </code>
                                <CopyWalletButton
                                  walletAddress={winner.wallet_address}
                                />
                              </div>
                            ) : (
                              <div className="mt-1 rounded-md bg-red-950/40 p-3 text-xs text-red-200">
                                Missing wallet
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </details>
            )
          )}
        </div>
      )}
    </div>
  );
}
