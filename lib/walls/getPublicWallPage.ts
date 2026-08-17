import "server-only";
import { getCycleSponsoredMeta } from "@/lib/cycles/sponsoredCycle";
import { supabaseServer } from "@/lib/db/server";
import {
  normalizeSubmissionPublicVisibilityStatus,
  SUBMISSION_PUBLIC_VISIBILITY,
} from "@/lib/moderation/submissionPublicVisibility";
import {
  PUBLIC_PAGINATION_CURSOR_VERSION,
  PUBLIC_PAGINATION_SCOPES,
  PUBLIC_SUBMISSION_PAGE_SIZE,
  type PublicPage,
} from "@/lib/pagination/publicPagination";
import {
  decodeServerPublicPaginationCursor,
  encodeServerPublicPaginationCursor,
} from "@/lib/pagination/publicPaginationCursor.server";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";
import {
  getSubmissionSocialLinksBySubmissionIds,
} from "@/lib/socials/getSubmissionSocialLinks";
import type { PublicWallItem } from "./publicWallTypes";
import {
  getPublicCycleNumberMap,
  requirePublicCycleNumber,
} from "@/lib/cycles/publicCycleNumber";
import { getServerWriteGateMode } from "@/lib/writeGate.server";

export type PublicWall = "fame" | "shame";

type WinnerRow = {
  id: number;
  submission_id: number;
  r2_key: string | null;
  cycle_id: number;
  payout_choice: string;
  split_percent: number | null;
  charity: string | null;
  wallet_address: string | null;
  claim_expired: boolean;
  vote_count: number | null;
  created_at: string | null;
};

type SubmissionRow = {
  id: number;
  discord_username_at_upload: string | null;
  discord_user_id: string;
  public_visibility_status: string | null;
  public_visibility_reason_code: string | null;
  public_visibility_reason_text: string | null;
};

type UserLogRow = {
  discord_user_id: string;
  public_profile_id: string | null;
};

export async function getPublicWallPage({
  cursor,
  wall,
}: {
  cursor?: string | null;
  wall: PublicWall;
}): Promise<PublicPage<PublicWallItem>> {
  if (getServerWriteGateMode() === "open") {
    const transitionResult = await supabaseServer.rpc(
      "process_due_winner_claim_transitions",
      { p_claim_id: null }
    );
    if (transitionResult.error) {
      throw new Error(
        `WALL_CLAIM_TRANSITION_FAILED:${transitionResult.error.code}`
      );
    }
  }

  const scope =
    wall === "fame"
      ? PUBLIC_PAGINATION_SCOPES.fame
      : PUBLIC_PAGINATION_SCOPES.shame;
  const context = { wall };
  const decodedCursor = cursor
    ? decodeServerPublicPaginationCursor(
        cursor,
        scope,
        context
      )
    : null;

  let query = supabaseServer
    .from("winner_public_profiles")
    .select(
      "id, submission_id, r2_key, cycle_id, payout_choice, split_percent, charity, wallet_address, claim_expired, vote_count, created_at"
    )
    .eq("wall", wall)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PUBLIC_SUBMISSION_PAGE_SIZE + 1);

  if (decodedCursor) {
    const { createdAt, id } = decodedCursor.values as {
      createdAt: string | null;
      id: number;
    };

    query =
      createdAt === null
        ? query.or(
            `and(created_at.is.null,id.lt.${id}),created_at.not.is.null`
          )
        : query.or(
            `and(created_at.eq.${createdAt},id.lt.${id}),created_at.lt.${createdAt}`
          );
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`WALL_QUERY_FAILED:${error.code}`);
  }

  const candidateRows = (data ?? []) as WinnerRow[];
  const hasMore =
    candidateRows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = candidateRows.slice(
    0,
    PUBLIC_SUBMISSION_PAGE_SIZE
  );
  const submissionIds = pageRows.map(
    (winner) => winner.submission_id
  );
  const submissionsResult =
    submissionIds.length > 0
      ? await supabaseServer
          .from("submissions")
          .select(
            "id, discord_username_at_upload, discord_user_id, public_visibility_status, public_visibility_reason_code, public_visibility_reason_text"
          )
          .in("id", submissionIds)
      : { data: [], error: null };

  if (submissionsResult.error) {
    throw new Error(
      `WALL_VISIBILITY_QUERY_FAILED:${submissionsResult.error.code}`
    );
  }

  const visibleSubmissions = (
    (submissionsResult.data ?? []) as SubmissionRow[]
  ).filter(
    (submission) =>
      normalizeSubmissionPublicVisibilityStatus(
        submission.public_visibility_status
      ) === SUBMISSION_PUBLIC_VISIBILITY.visible
  );
  const submissionById = new Map(
    visibleSubmissions.map((submission) => [
      submission.id,
      submission,
    ])
  );
  const visibleRows = pageRows.filter((winner) =>
    submissionById.has(winner.submission_id)
  );
  const discordUserIds = Array.from(
    new Set(
      visibleSubmissions.map(
        (submission) => submission.discord_user_id
      )
    )
  );
  const visibleSubmissionIds = visibleRows.map(
    (winner) => winner.submission_id
  );
  const cycleIds = Array.from(
    new Set(visibleRows.map((winner) => winner.cycle_id))
  );
  const [
    userLogsResult,
    socialLinksBySubmissionId,
    sponsorEntries,
    publicNumberByCycleId,
  ] =
    await Promise.all([
      discordUserIds.length > 0
        ? supabaseServer
            .from("user_logs")
            .select("discord_user_id, public_profile_id")
            .in("discord_user_id", discordUserIds)
        : Promise.resolve({ data: [], error: null }),
      getSubmissionSocialLinksBySubmissionIds(
        visibleSubmissionIds
      ),
      Promise.all(
        cycleIds.map(async (cycleId) => [
          cycleId,
          await getCycleSponsoredMeta(
            cycleId,
            wall === "fame" ? "fame_modal" : "shame_modal"
          ),
        ] as const)
      ),
      getPublicCycleNumberMap(cycleIds),
    ]);

  if (userLogsResult.error) {
    throw new Error(
      `WALL_PROFILE_QUERY_FAILED:${userLogsResult.error.code}`
    );
  }

  const profileIdByDiscordUserId = new Map(
    ((userLogsResult.data ?? []) as UserLogRow[]).map(
      (userLog) => [
        userLog.discord_user_id,
        userLog.public_profile_id,
      ]
    )
  );
  const sponsoredMetaByCycleId = new Map(sponsorEntries);
  const items = visibleRows.map((winner): PublicWallItem => {
    const submission = submissionById.get(
      winner.submission_id
    )!;

    return {
      id: winner.id,
      submission_id: winner.submission_id,
      image_url: getPublicImageUrl(winner.r2_key) ?? null,
      cycle_id: winner.cycle_id,
      cycle_number: requirePublicCycleNumber(
        publicNumberByCycleId.get(winner.cycle_id)
      ),
      created_at: winner.created_at,
      discord_username:
        submission.discord_username_at_upload ?? "unknown",
      public_profile_id:
        profileIdByDiscordUserId.get(
          submission.discord_user_id
        ) ?? null,
      payout_choice: winner.payout_choice,
      split_percent: winner.split_percent,
      charity: winner.charity,
      wallet_address:
        winner.payout_choice === "keep" || winner.payout_choice === "split"
          ? winner.wallet_address
          : null,
      claim_expired: winner.claim_expired === true,
      vote_count: winner.vote_count,
      public_visibility_status:
        normalizeSubmissionPublicVisibilityStatus(
          submission.public_visibility_status
        ),
      public_visibility_reason_code:
        submission.public_visibility_reason_code,
      public_visibility_reason_text:
        submission.public_visibility_reason_text,
      social_links:
        socialLinksBySubmissionId.get(winner.submission_id) ??
        [],
      sponsored_meta:
        sponsoredMetaByCycleId.get(winner.cycle_id) ?? null,
    };
  });
  const lastScannedRow = pageRows.at(-1);

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && lastScannedRow
        ? encodeServerPublicPaginationCursor({
            version: PUBLIC_PAGINATION_CURSOR_VERSION,
            scope,
            context,
            values: {
              createdAt: lastScannedRow.created_at
                ? new Date(
                    lastScannedRow.created_at
                  ).toISOString()
                : null,
              id: lastScannedRow.id,
            },
          })
        : null,
  };
}
