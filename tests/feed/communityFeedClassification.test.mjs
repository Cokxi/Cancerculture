import assert from "node:assert/strict";
import test from "node:test";

const FEED_CLASSIFICATION_VERSION = 1;

function classifyFinalizedSubmissions(entries) {
  const voteTiersDescending = [
    ...new Set(entries.map((entry) => entry.finalVoteCount)),
  ].sort((left, right) => right - left);
  const rankByVotes = new Map(
    voteTiersDescending.map((votes, index) => [votes, index + 1]),
  );
  const positiveEntries = entries.filter((entry) => entry.finalVoteCount > 0);
  const capacity = Math.floor(positiveEntries.length * 0.1);
  const positiveTiersAscending = [
    ...new Set(positiveEntries.map((entry) => entry.finalVoteCount)),
  ].sort((left, right) => left - right);
  const trashVotes = new Set();
  let cumulativeSize = 0;

  for (const votes of positiveTiersAscending) {
    cumulativeSize += positiveEntries.filter(
      (entry) => entry.finalVoteCount === votes,
    ).length;
    if (cumulativeSize <= capacity) trashVotes.add(votes);
  }

  return entries.map((entry) => ({
    ...entry,
    rankInCycle: rankByVotes.get(entry.finalVoteCount),
    tieGroup: rankByVotes.get(entry.finalVoteCount),
    feedEligible: entry.finalVoteCount > 0,
    feedTrash:
      entry.finalVoteCount > 0 && trashVotes.has(entry.finalVoteCount),
    feedClassificationVersion: FEED_CLASSIFICATION_VERSION,
    isDisqualifiedAtFinalization: false,
  }));
}

function entries(voteCounts) {
  return voteCounts.map((finalVoteCount, index) => ({
    submissionId: index + 1,
    finalVoteCount,
    publicVisibilityStatusAtFinalization: "visible",
  }));
}

function trashIds(classification) {
  return classification
    .filter((entry) => entry.feedTrash)
    .map((entry) => entry.submissionId);
}

test("nine positive Submissions have zero Trash capacity", () => {
  const classification = classifyFinalizedSubmissions(
    entries([1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );

  assert.deepEqual(trashIds(classification), []);
  assert.equal(classification.every((entry) => entry.feedEligible), true);
});

test("ten positive Submissions with one lowest Vote tier classify exactly one as Trash", () => {
  const classification = classifyFinalizedSubmissions(
    entries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  );

  assert.deepEqual(trashIds(classification), [1]);
});

test("a lowest tie tier that exceeds capacity leaves Trash empty", () => {
  const classification = classifyFinalizedSubmissions(
    entries([1, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );

  assert.deepEqual(trashIds(classification), []);
});

test("Zero-Vote Submissions are in neither finalized Feed eligibility nor the Trash denominator", () => {
  const classification = classifyFinalizedSubmissions(
    entries([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  );
  const zeroVoteRows = classification.filter(
    (entry) => entry.finalVoteCount === 0,
  );

  assert.equal(zeroVoteRows.length, 2);
  assert.equal(
    zeroVoteRows.every(
      (entry) => !entry.feedEligible && !entry.feedTrash,
    ),
    true,
  );
  assert.deepEqual(trashIds(classification), [3]);
});

test("Dense Rank at or below ten includes every tie at the boundary", () => {
  const classification = classifyFinalizedSubmissions(
    entries([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 11, 10]),
  );
  const topTen = classification.filter(
    (entry) => entry.feedEligible && entry.rankInCycle <= 10,
  );

  assert.equal(topTen.length, 11);
  assert.equal(
    topTen.filter((entry) => entry.finalVoteCount === 11).length,
    2,
  );
  assert.equal(
    topTen.every((entry) => entry.tieGroup === entry.rankInCycle),
    true,
  );
});

test("synthetic finalized Feed smoke separates Top 10, All, Trash, and zero-Vote rows", () => {
  const classification = classifyFinalizedSubmissions(
    entries([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 11, 9, 8, 7, 6, 5, 4, 1, 0, 0]),
  );
  const topTenIds = classification
    .filter((entry) => entry.feedEligible && entry.rankInCycle <= 10)
    .map((entry) => entry.submissionId);
  const allIds = classification
    .filter((entry) => entry.feedEligible && !entry.feedTrash)
    .map((entry) => entry.submissionId);

  assert.deepEqual(topTenIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(allIds.length, 17);
  assert.equal(allIds.includes(18), false);
  assert.deepEqual(trashIds(classification), [18]);
  assert.equal(
    classification.slice(18).every((entry) => !entry.feedEligible),
    true,
  );
});

test("finalization replay produces byte-for-byte equivalent classification data", () => {
  const input = entries([0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
  const first = classifyFinalizedSubmissions(input);
  const replay = classifyFinalizedSubmissions(structuredClone(input));

  assert.deepEqual(replay, first);
});

test("backfill derives only from stored final Votes and retains historical DQ/visibility snapshots", () => {
  const snapshots = entries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map(
    (entry, index) => ({
      ...entry,
      publicVisibilityStatusAtFinalization:
        index === 0 ? "legal_review" : "visible",
      currentPublicVisibilityStatus: index === 0 ? "visible" : "removed",
      currentIsDisqualified: index > 0,
    }),
  );
  const classification = classifyFinalizedSubmissions(snapshots);

  assert.deepEqual(trashIds(classification), [1]);
  assert.equal(
    classification[0].publicVisibilityStatusAtFinalization,
    "legal_review",
  );
  assert.equal(classification[0].currentPublicVisibilityStatus, "visible");
  assert.equal(classification[1].currentIsDisqualified, true);
  assert.equal(classification[1].isDisqualifiedAtFinalization, false);
});

test("validated dimensions accept canonical pairs while legacy rows remain null/null", () => {
  const validDimensions = (width, height) =>
    (width === null && height === null) ||
    (Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 1 &&
      width <= 2400 &&
      height >= 1 &&
      height <= 16383 &&
      width * height <= 24_000_000);

  assert.equal(validDimensions(null, null), true);
  assert.equal(validDimensions(2400, 10_000), true);
  assert.equal(validDimensions(null, 1080), false);
  assert.equal(validDimensions(2401, 100), false);
  assert.equal(validDimensions(2400, 10_001), false);
});
