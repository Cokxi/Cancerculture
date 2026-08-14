import "server-only";

import { requirePublicCycleNumber } from "@/lib/cycles/publicCycleNumber";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  PUBLIC_SUBMISSION_PAGE_SIZE,
} from "@/lib/pagination/publicPagination";
import {
  COMMUNITY_FEED_CLASSIFICATION_VERSION,
  COMMUNITY_FEED_CYCLE_CATALOG_PAGE_SIZE,
  canonicalFeedTimestamp,
  getFinalizedFeedKeysetFilter,
  getCommunityFeedMediaPath,
  getLiveFeedKeysetFilter,
  preciseFeedCursorTimestamp,
  type CommunityFeedAnchorResolution,
  type CommunityFeedContext,
  type CommunityFeedCycleCatalogPage,
  type CommunityFeedItem,
  type CommunityFeedKind,
  type CommunityFeedPage,
  type FinalizedCommunityFeedKind,
  type FinalizedFeedCursorTuple,
  type FinalizedFeedKeysetTuple,
  type LiveFeedCursorTuple,
} from "@/lib/feed/communityFeed";
import {
  decodeFinalizedFeedCursor,
  decodeLiveFeedCursor,
  decodeCommunityFeedCycleCatalogCursor,
  encodeCommunityFeedCycleCatalogCursor,
  encodeFinalizedFeedCursor,
  encodeLiveFeedCursor,
} from "@/lib/feed/communityFeedCursor.server";

const LIVE_CYCLE_STATUSES = [
  "submission_open",
  "submission_closed",
  "voting_open",
  "voting_closed",
  "paused",
  "active",
] as const;

const LIVE_CONTEXT_RETRY_LIMIT = 1;

const FINALIZED_FEED_SELECT = `
  cycle_id,
  submission_id,
  final_vote_count,
  rank_in_cycle,
  finalized_at,
  feed_classification_version,
  submissions!inner(
    id,
    cycle_id,
    r2_key,
    media_width,
    media_height,
    created_at,
    public_visibility_status,
    is_disqualified
  ),
  voting_cycles!inner(
    id,
    public_number,
    status
  )
`;

type LiveCycleRow = {
  id: number;
  public_number: number | null;
  reset_count: number | null;
};

type LiveSubmissionRow = {
  id: number;
  cycle_id: number;
  r2_key: string | null;
  media_width: number | null;
  media_height: number | null;
  created_at: string;
};

type FinalizedSubmissionRow = LiveSubmissionRow & {
  public_visibility_status: string | null;
  is_disqualified: boolean | null;
};

type FinalizedCycleRow = {
  id: number;
  public_number: number | null;
  status: string;
};

type FinalizedCycleFilterRow = FinalizedCycleRow & {
  starts_at: string | null;
  ends_at: string | null;
  finalized_at: string | null;
};

type FinalizedCycleCatalogRow = {
  public_number: number | null;
  starts_at: string | null;
  ends_at: string | null;
};

type FinalizedFeedRow = {
  cycle_id: number;
  submission_id: number;
  final_vote_count: number | null;
  rank_in_cycle: number | null;
  finalized_at: string | null;
  feed_classification_version: number | null;
  submissions: FinalizedSubmissionRow | FinalizedSubmissionRow[];
  voting_cycles: FinalizedCycleRow | FinalizedCycleRow[];
};

function requireSubmissionId(submissionId: number) {
  if (!Number.isSafeInteger(submissionId) || submissionId <= 0) {
    throw new Error("COMMUNITY_FEED_SUBMISSION_ID_INVALID");
  }

  return submissionId;
}

function embeddedRow<T>(value: T | T[]): T {
  const row = Array.isArray(value) ? value[0] : value;

  if (!row) {
    throw new Error("COMMUNITY_FEED_RELATED_ROW_UNAVAILABLE");
  }

  return row;
}

function liveContext(
  cycle: LiveCycleRow
): Extract<CommunityFeedContext, { kind: "live" }> {
  return {
    kind: "live",
    cycleNumber: requirePublicCycleNumber(cycle.public_number),
    resetCount: cycle.reset_count ?? 0,
  };
}

function liveCyclesMatch(
  expected: LiveCycleRow,
  actual: LiveCycleRow | null
) {
  return (
    actual !== null &&
    actual.id === expected.id &&
    actual.public_number === expected.public_number &&
    (actual.reset_count ?? 0) === (expected.reset_count ?? 0)
  );
}

function emptyLiveFeedPage(
  cursorState: CommunityFeedPage["cursorState"]
): CommunityFeedPage {
  return {
    items: [],
    nextCursor: null,
    hasMore: false,
    feed: "live",
    context: null,
    cursorState,
  };
}

function finalizedContext(cycleNumber: number | null): Extract<
  CommunityFeedContext,
  { kind: "finalized" }
> {
  return {
    kind: "finalized",
    classificationVersion: COMMUNITY_FEED_CLASSIFICATION_VERSION,
    cycleNumber,
  };
}

function liveTuple(row: LiveSubmissionRow): LiveFeedCursorTuple {
  return {
    createdAt: preciseFeedCursorTimestamp(row.created_at),
    submissionId: row.id,
  };
}

function finalizedTuple(
  row: FinalizedFeedRow
): FinalizedFeedCursorTuple {
  if (
    row.finalized_at === null ||
    row.rank_in_cycle === null
  ) {
    throw new Error("COMMUNITY_FEED_FINALIZED_TUPLE_INVALID");
  }

  return {
    finalizedAt: preciseFeedCursorTimestamp(row.finalized_at),
    cycleNumber: requirePublicCycleNumber(
      embeddedRow(row.voting_cycles).public_number
    ),
    rankInCycle: row.rank_in_cycle,
    submissionId: row.submission_id,
  };
}

function finalizedKeysetTuple(
  row: FinalizedFeedRow
): FinalizedFeedKeysetTuple {
  const tuple = finalizedTuple(row);
  return {
    finalizedAt: tuple.finalizedAt,
    cycleId: row.cycle_id,
    rankInCycle: tuple.rankInCycle,
    submissionId: tuple.submissionId,
  };
}

function tuplesMatch<T extends object>(left: T, right: T) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapLiveItem(
  row: LiveSubmissionRow,
  cycleNumber: number
): CommunityFeedItem {
  return {
    submissionId: row.id,
    cycleNumber,
    imageUrl: row.r2_key
      ? getCommunityFeedMediaPath("live", row.id)
      : null,
    mediaWidth: row.media_width,
    mediaHeight: row.media_height,
    createdAt: canonicalFeedTimestamp(row.created_at),
    finalizedAt: null,
    finalVoteCount: null,
    rankInCycle: null,
  };
}

function mapFinalizedItem(
  row: FinalizedFeedRow,
  feed: FinalizedCommunityFeedKind,
  selectedCycleNumber: number | null
): CommunityFeedItem {
  const submission = embeddedRow(row.submissions);
  const cycle = embeddedRow(row.voting_cycles);

  if (
    submission.id !== row.submission_id ||
    submission.cycle_id !== row.cycle_id ||
    cycle.id !== row.cycle_id ||
    row.final_vote_count === null ||
    row.final_vote_count <= 0 ||
    row.rank_in_cycle === null ||
    row.feed_classification_version !==
      COMMUNITY_FEED_CLASSIFICATION_VERSION
  ) {
    throw new Error("COMMUNITY_FEED_FINALIZED_ROW_INVALID");
  }

  return {
    submissionId: row.submission_id,
    cycleNumber: requirePublicCycleNumber(cycle.public_number),
    imageUrl: submission.r2_key
      ? getCommunityFeedMediaPath(
          feed,
          row.submission_id,
          selectedCycleNumber
        )
      : null,
    mediaWidth: submission.media_width,
    mediaHeight: submission.media_height,
    createdAt: canonicalFeedTimestamp(submission.created_at),
    finalizedAt: canonicalFeedTimestamp(finalizedTuple(row).finalizedAt),
    finalVoteCount: row.final_vote_count,
    rankInCycle: row.rank_in_cycle,
  };
}

async function getCurrentLiveFeedCycle() {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, public_number, reset_count")
    .in("status", [...LIVE_CYCLE_STATUSES])
    .not("public_number", "is", null)
    .order("id", { ascending: false })
    .limit(2);

  if (error) {
    throw new Error(`COMMUNITY_FEED_CYCLE_QUERY_FAILED:${error.code}`);
  }

  const rows = (data ?? []) as LiveCycleRow[];

  if (rows.length > 1) {
    throw new Error("COMMUNITY_FEED_MULTIPLE_LIVE_CYCLES");
  }

  return rows[0] ?? null;
}

function finalizedFeedQuery(
  feed: FinalizedCommunityFeedKind,
  cycleId: number | null = null
) {
  let query = supabaseAdmin
    .from("cycle_results")
    .select(FINALIZED_FEED_SELECT)
    .eq(
      "feed_classification_version",
      COMMUNITY_FEED_CLASSIFICATION_VERSION
    )
    .eq("feed_eligible", true)
    .gt("final_vote_count", 0)
    .not("finalized_at", "is", null)
    .not("rank_in_cycle", "is", null)
    .eq("submissions.public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false", {
      referencedTable: "submissions",
    })
    .eq("voting_cycles.status", "finished")
    .not("voting_cycles.public_number", "is", null);

  if (feed === "top10") {
    query = query.lte("rank_in_cycle", 10);
  } else {
    query = query.eq("feed_trash", feed === "trash");
  }

  if (cycleId !== null) {
    query = query.eq("cycle_id", cycleId);
  }

  return query;
}

function requireCycleNumber(cycleNumber: number) {
  if (!Number.isSafeInteger(cycleNumber) || cycleNumber <= 0) {
    throw new Error("COMMUNITY_FEED_CYCLE_NUMBER_INVALID");
  }
  return cycleNumber;
}

async function getFinalizedCycleFilter(cycleNumber: number) {
  const { data, error } = await supabaseAdmin
    .from("voting_cycles")
    .select("id, public_number, status, starts_at, ends_at, finalized_at")
    .eq("public_number", requireCycleNumber(cycleNumber))
    .eq("status", "finished")
    .not("starts_at", "is", null)
    .not("ends_at", "is", null)
    .not("finalized_at", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `COMMUNITY_FEED_CYCLE_FILTER_QUERY_FAILED:${error.code}`
    );
  }

  return (data as FinalizedCycleFilterRow | null) ?? null;
}

export async function getCommunityFeedCycleCatalogPage({
  cursor,
}: {
  cursor?: string | null;
} = {}): Promise<CommunityFeedCycleCatalogPage> {
  const decoded = cursor
    ? decodeCommunityFeedCycleCatalogCursor(cursor)
    : null;
  let query = supabaseAdmin
    .from("voting_cycles")
    .select("public_number, starts_at, ends_at")
    .eq("status", "finished")
    .not("public_number", "is", null)
    .not("starts_at", "is", null)
    .not("ends_at", "is", null)
    .not("finalized_at", "is", null)
    .order("public_number", { ascending: false });

  if (decoded) {
    query = query.lt("public_number", decoded.values.cycleNumber);
  }

  const { data, error } = await query.limit(
    COMMUNITY_FEED_CYCLE_CATALOG_PAGE_SIZE + 1
  );

  if (error) {
    throw new Error(
      `COMMUNITY_FEED_CYCLE_CATALOG_QUERY_FAILED:${error.code}`
    );
  }

  const rows = (data ?? []) as FinalizedCycleCatalogRow[];
  const hasMore = rows.length > COMMUNITY_FEED_CYCLE_CATALOG_PAGE_SIZE;
  const pageRows = rows.slice(0, COMMUNITY_FEED_CYCLE_CATALOG_PAGE_SIZE);
  const items = pageRows.map((row) => {
    if (!row.starts_at || !row.ends_at) {
      throw new Error("COMMUNITY_FEED_CYCLE_CATALOG_ROW_INVALID");
    }
    return {
      cycleNumber: requirePublicCycleNumber(row.public_number),
      startsAt: canonicalFeedTimestamp(row.starts_at),
      endsAt: canonicalFeedTimestamp(row.ends_at),
    };
  });
  const lastItem = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && lastItem
        ? encodeCommunityFeedCycleCatalogCursor(lastItem.cycleNumber)
        : null,
    hasMore,
  };
}

async function getLiveAnchorRow(
  cycleId: number,
  submissionId: number
) {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, media_width, media_height, created_at"
    )
    .eq("cycle_id", cycleId)
    .eq("id", requireSubmissionId(submissionId))
    .eq("public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `COMMUNITY_FEED_LIVE_ANCHOR_QUERY_FAILED:${error.code}`
    );
  }

  return (data as LiveSubmissionRow | null) ?? null;
}

async function getFinalizedAnchorRow(
  feed: FinalizedCommunityFeedKind,
  submissionId: number,
  cycleId: number | null
) {
  const { data, error } = await finalizedFeedQuery(feed, cycleId)
    .eq("submission_id", requireSubmissionId(submissionId))
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `COMMUNITY_FEED_FINALIZED_ANCHOR_QUERY_FAILED:${error.code}`
    );
  }

  return (data as FinalizedFeedRow | null) ?? null;
}

async function getLiveFeedPage(
  cursor?: string | null,
  retriesRemaining = LIVE_CONTEXT_RETRY_LIMIT,
  resetAfterContextChange = false
): Promise<CommunityFeedPage> {
  const decodedCursor = cursor
    ? decodeLiveFeedCursor(cursor)
    : null;
  const cycle = await getCurrentLiveFeedCycle();

  if (!cycle) {
    return emptyLiveFeedPage(
      cursor || resetAfterContextChange
        ? "context_unavailable_reset"
        : "start"
    );
  }

  const context = liveContext(cycle);
  let cursorTuple: LiveFeedCursorTuple | null = null;
  let cursorState: CommunityFeedPage["cursorState"] =
    resetAfterContextChange
      ? "context_unavailable_reset"
      : "start";

  if (decodedCursor) {
    if (
      decodedCursor.context.cycleNumber !== context.cycleNumber ||
      decodedCursor.context.resetCount !== (cycle.reset_count ?? 0)
    ) {
      cursorState = "context_unavailable_reset";
    } else {
      const expectedTuple = decodedCursor.values;
      const anchor = await getLiveAnchorRow(
        cycle.id,
        expectedTuple.submissionId
      );

      if (anchor && tuplesMatch(liveTuple(anchor), expectedTuple)) {
        cursorTuple = expectedTuple;
        cursorState = "continued";
      } else {
        cursorState = "anchor_unavailable_reset";
      }
    }
  }

  let query = supabaseAdmin
    .from("submissions")
    .select(
      "id, cycle_id, r2_key, media_width, media_height, created_at"
    )
    .eq("cycle_id", cycle.id)
    .eq("public_visibility_status", "visible")
    .or("is_disqualified.is.null,is_disqualified.eq.false")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (cursorTuple) {
    query = query.or(getLiveFeedKeysetFilter(cursorTuple));
  }

  const { data, error } = await query.limit(
    PUBLIC_SUBMISSION_PAGE_SIZE + 1
  );

  if (error) {
    throw new Error(`COMMUNITY_FEED_LIVE_QUERY_FAILED:${error.code}`);
  }

  const verifiedCycle = await getCurrentLiveFeedCycle();

  if (!liveCyclesMatch(cycle, verifiedCycle)) {
    if (retriesRemaining > 0) {
      return getLiveFeedPage(
        null,
        retriesRemaining - 1,
        true
      );
    }

    return emptyLiveFeedPage("context_unavailable_reset");
  }

  const rows = (data ?? []) as LiveSubmissionRow[];
  const hasMore = rows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = rows.slice(0, PUBLIC_SUBMISSION_PAGE_SIZE);
  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map((row) =>
      mapLiveItem(row, context.cycleNumber)
    ),
    nextCursor:
      hasMore && lastRow
        ? encodeLiveFeedCursor({
            cycleNumber: context.cycleNumber,
            resetCount: cycle.reset_count ?? 0,
            tuple: liveTuple(lastRow),
          })
        : null,
    hasMore,
    feed: "live",
    context,
    cursorState,
  } satisfies CommunityFeedPage;
}

async function resolveLiveFeedAnchor(
  submissionId: number,
  retriesRemaining = LIVE_CONTEXT_RETRY_LIMIT
): Promise<CommunityFeedAnchorResolution> {
  const feed = "live" as const;
  const cycle = await getCurrentLiveFeedCycle();

  if (!cycle) {
    return {
      feed,
      submissionId,
      status: "context_unavailable",
      context: null,
      item: null,
      resumeCursor: null,
    };
  }

  const anchor = await getLiveAnchorRow(cycle.id, submissionId);
  const verifiedCycle = await getCurrentLiveFeedCycle();

  if (!liveCyclesMatch(cycle, verifiedCycle)) {
    if (retriesRemaining > 0) {
      return resolveLiveFeedAnchor(
        submissionId,
        retriesRemaining - 1
      );
    }

    return {
      feed,
      submissionId,
      status: "context_unavailable",
      context: null,
      item: null,
      resumeCursor: null,
    };
  }

  const context = liveContext(cycle);

  return anchor
    ? {
        feed,
        submissionId,
        status: "resolved",
        context,
        item: mapLiveItem(anchor, context.cycleNumber),
        resumeCursor: encodeLiveFeedCursor({
          cycleNumber: context.cycleNumber,
          resetCount: cycle.reset_count ?? 0,
          tuple: liveTuple(anchor),
        }),
      }
    : {
        feed,
        submissionId,
        status: "unavailable",
        context,
        item: null,
        resumeCursor: null,
      };
}

async function getFinalizedFeedPage(
  feed: FinalizedCommunityFeedKind,
  cursor?: string | null,
  selectedCycleNumber: number | null = null
) {
  const decoded = cursor
    ? decodeFinalizedFeedCursor(cursor, feed, selectedCycleNumber)
    : null;
  const cycleFilter =
    selectedCycleNumber === null
      ? null
      : await getFinalizedCycleFilter(selectedCycleNumber);
  const context = finalizedContext(selectedCycleNumber);
  if (selectedCycleNumber !== null && !cycleFilter) {
    return {
      items: [],
      nextCursor: null,
      hasMore: false,
      feed,
      context,
      cursorState: cursor ? "context_unavailable_reset" : "start",
    } satisfies CommunityFeedPage;
  }

  let cursorTuple: FinalizedFeedKeysetTuple | null = null;
  let cursorState: CommunityFeedPage["cursorState"] = "start";

  if (decoded) {
    const expectedTuple = decoded.values;
    const anchor = await getFinalizedAnchorRow(
      feed,
      expectedTuple.submissionId,
      cycleFilter?.id ?? null
    );

    if (
      anchor &&
      tuplesMatch(finalizedTuple(anchor), expectedTuple)
    ) {
      cursorTuple = finalizedKeysetTuple(anchor);
      cursorState = "continued";
    } else {
      cursorState = "anchor_unavailable_reset";
    }
  }

  let query = finalizedFeedQuery(feed, cycleFilter?.id ?? null)
    .order("finalized_at", { ascending: false })
    .order("cycle_id", { ascending: false })
    .order("rank_in_cycle", { ascending: true })
    .order("submission_id", { ascending: true });

  if (cursorTuple) {
    query = query.or(
      getFinalizedFeedKeysetFilter(cursorTuple)
    );
  }

  const { data, error } = await query.limit(
    PUBLIC_SUBMISSION_PAGE_SIZE + 1
  );

  if (error) {
    throw new Error(
      `COMMUNITY_FEED_FINALIZED_QUERY_FAILED:${error.code}`
    );
  }

  const rows = (data ?? []) as unknown as FinalizedFeedRow[];
  const hasMore = rows.length > PUBLIC_SUBMISSION_PAGE_SIZE;
  const pageRows = rows.slice(0, PUBLIC_SUBMISSION_PAGE_SIZE);
  const lastRow = pageRows.at(-1);

  return {
    items: pageRows.map((row) =>
      mapFinalizedItem(row, feed, selectedCycleNumber)
    ),
    nextCursor:
      hasMore && lastRow
        ? encodeFinalizedFeedCursor({
            feed,
            cycleNumber: selectedCycleNumber,
            tuple: finalizedTuple(lastRow),
          })
        : null,
    hasMore,
    feed,
    context,
    cursorState,
  } satisfies CommunityFeedPage;
}

export async function getCommunityFeedPage({
  feed,
  cursor,
  cycleNumber = null,
}: {
  feed: CommunityFeedKind;
  cursor?: string | null;
  cycleNumber?: number | null;
}): Promise<CommunityFeedPage> {
  if (feed === "live" && cycleNumber !== null) {
    throw new Error("COMMUNITY_FEED_CYCLE_FILTER_INVALID");
  }
  if (cycleNumber !== null) requireCycleNumber(cycleNumber);
  return feed === "live"
    ? getLiveFeedPage(cursor)
    : getFinalizedFeedPage(feed, cursor, cycleNumber);
}

export async function resolveCommunityFeedAnchor({
  feed,
  submissionId,
  cycleNumber = null,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  cycleNumber?: number | null;
}): Promise<CommunityFeedAnchorResolution> {
  requireSubmissionId(submissionId);

  if (feed === "live" && cycleNumber !== null) {
    throw new Error("COMMUNITY_FEED_CYCLE_FILTER_INVALID");
  }
  if (cycleNumber !== null) requireCycleNumber(cycleNumber);

  if (feed === "live") {
    return resolveLiveFeedAnchor(submissionId);
  }

  const context = finalizedContext(cycleNumber);
  const cycleFilter =
    cycleNumber === null ? null : await getFinalizedCycleFilter(cycleNumber);
  if (cycleNumber !== null && !cycleFilter) {
    return {
      feed,
      submissionId,
      status: "context_unavailable",
      context,
      item: null,
      resumeCursor: null,
    };
  }
  const anchor = await getFinalizedAnchorRow(
    feed,
    submissionId,
    cycleFilter?.id ?? null
  );

  return anchor
    ? {
        feed,
        submissionId,
        status: "resolved",
        context,
        item: mapFinalizedItem(anchor, feed, cycleNumber),
        resumeCursor: encodeFinalizedFeedCursor({
          feed,
          cycleNumber,
          tuple: finalizedTuple(anchor),
        }),
      }
    : {
        feed,
        submissionId,
        status: "unavailable",
        context,
        item: null,
        resumeCursor: null,
      };
}

export async function resolveCommunityFeedMediaSource({
  feed,
  submissionId,
  cycleNumber = null,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
  cycleNumber?: number | null;
}): Promise<{ r2Key: string } | null> {
  requireSubmissionId(submissionId);

  if (feed === "live" && cycleNumber !== null) return null;
  if (cycleNumber !== null) requireCycleNumber(cycleNumber);

  if (feed === "live") {
    const cycle = await getCurrentLiveFeedCycle();
    if (!cycle) return null;

    const submission = await getLiveAnchorRow(cycle.id, submissionId);
    const verifiedCycle = await getCurrentLiveFeedCycle();

    if (
      !submission?.r2_key ||
      !liveCyclesMatch(cycle, verifiedCycle)
    ) {
      return null;
    }

    return { r2Key: submission.r2_key };
  }

  const cycleFilter =
    cycleNumber === null ? null : await getFinalizedCycleFilter(cycleNumber);
  if (cycleNumber !== null && !cycleFilter) return null;
  const result = await getFinalizedAnchorRow(
    feed,
    submissionId,
    cycleFilter?.id ?? null
  );
  if (!result) return null;

  const submission = embeddedRow(result.submissions);
  return submission.r2_key ? { r2Key: submission.r2_key } : null;
}

export async function resolveCommunityFeedCycleSource({
  feed,
  submissionId,
}: {
  feed: CommunityFeedKind;
  submissionId: number;
}): Promise<{ cycleId: number } | null> {
  requireSubmissionId(submissionId);

  if (feed === "live") {
    const cycle = await getCurrentLiveFeedCycle();
    if (!cycle) return null;

    const submission = await getLiveAnchorRow(cycle.id, submissionId);
    const verifiedCycle = await getCurrentLiveFeedCycle();
    return submission && liveCyclesMatch(cycle, verifiedCycle)
      ? { cycleId: cycle.id }
      : null;
  }

  const result = await getFinalizedAnchorRow(feed, submissionId, null);
  return result ? { cycleId: result.cycle_id } : null;
}
