import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkTargetedMediaCleanupQueueIds,
  createEmptyMediaCleanupBatchResult,
  drainDueMediaCleanupBatches,
  processTargetedMediaCleanupBatches,
  verifyTargetedMediaCleanupPostflight,
} from "../../lib/r2/mediaCleanupState.ts";

function batch(overrides = {}) {
  return { ...createEmptyMediaCleanupBatchResult(), ...overrides };
}

for (const count of [0, 1, 10, 11, 20]) {
  test(`targeted reset cleanup covers all ${count} queue jobs in true ten-item batches`, async () => {
    const queueIds = Array.from({ length: count }, (_, index) => index + 1);
    const seen = [];
    const result = await processTargetedMediaCleanupBatches({
      queueIds,
      processBatch: async (ids) => {
        seen.push(...ids);
        return batch({ claimed: ids.length, completed: ids.length });
      },
    });

    assert.deepEqual(seen, queueIds);
    assert.deepEqual(
      chunkTargetedMediaCleanupQueueIds(queueIds).map((ids) => ids.length),
      count === 0 ? [] : count <= 10 ? [count] : [10, count - 10],
    );
    assert.equal(result.completed, count);
    assert.equal(result.batchFailures, 0);
    assert.equal(result.drainComplete, true);
  });
}

test("due cleanup drains multiple full batches and confirms the empty tail", async () => {
  const batches = [
    batch({ claimed: 10, completed: 10 }),
    batch({ claimed: 10, completed: 9, retryScheduled: 1 }),
    batch(),
  ];
  let index = 0;

  const result = await drainDueMediaCleanupBatches({
    processBatch: async () => batches[index++],
  });

  assert.equal(result.claimed, 20);
  assert.equal(result.completed, 19);
  assert.equal(result.retryScheduled, 1);
  assert.equal(result.batchesAttempted, 3);
  assert.equal(result.drainComplete, true);
  assert.equal(index, 3);
});

test("due cleanup reports a bounded incomplete drain instead of skipping work", async () => {
  let calls = 0;
  const result = await drainDueMediaCleanupBatches({
    maxBatches: 2,
    processBatch: async () => {
      calls += 1;
      return batch({ claimed: 10, completed: 10 });
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.completed, 20);
  assert.equal(result.drainComplete, false);
});

test("targeted partial success is retained without claiming complete drain", async () => {
  const queueIds = Array.from({ length: 20 }, (_, index) => index + 1);
  let calls = 0;
  const result = await processTargetedMediaCleanupBatches({
    queueIds,
    processBatch: async (ids) => {
      calls += 1;
      if (calls === 2) throw new Error("website unavailable");
      return batch({ claimed: ids.length, completed: ids.length });
    },
  });

  assert.equal(result.completed, 10);
  assert.equal(result.batchFailures, 1);
  assert.equal(result.drainComplete, false);
});

test("reset postflight requires both completed queue state and missing R2 objects", async () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({
    id: index + 1,
    storage_provider: "r2",
    storage_key: `cycle/${index + 1}.webp`,
    status: "completed",
  }));
  const postflight = await verifyTargetedMediaCleanupPostflight({
    queueIds: rows.map((row) => row.id),
    rows,
    probeObject: async () => "missing",
  });

  assert.equal(postflight.completedQueueJobs, 11);
  assert.equal(postflight.objectsMissing, 11);
  assert.equal(postflight.drained, true);
});

test("reset postflight never confirms partial, retryable, terminal, present, or unverifiable work", async () => {
  const rows = [
    { id: 1, storage_provider: "r2", storage_key: "cycle/1.webp", status: "completed" },
    { id: 2, storage_provider: "r2", storage_key: "cycle/2.webp", status: "failed" },
    { id: 3, storage_provider: "r2", storage_key: "cycle/3.webp", status: "dead" },
    { id: 4, storage_provider: "r2", storage_key: "cycle/4.webp", status: "completed" },
  ];
  const postflight = await verifyTargetedMediaCleanupPostflight({
    queueIds: [1, 2, 3, 4, 5],
    rows,
    probeObject: async (row) => {
      if (row.id === 4) throw new Error("provider unavailable");
      return row.id === 1 ? "present" : "missing";
    },
  });

  assert.equal(postflight.retryableQueueJobs, 1);
  assert.equal(postflight.terminalQueueJobs, 1);
  assert.equal(postflight.missingQueueJobs, 1);
  assert.equal(postflight.objectsPresent, 1);
  assert.equal(postflight.objectVerificationFailures, 1);
  assert.equal(postflight.drained, false);
});

test("empty reset cleanup is a verified safe no-op", async () => {
  const postflight = await verifyTargetedMediaCleanupPostflight({
    queueIds: [],
    rows: [],
    probeObject: async () => {
      throw new Error("must not run");
    },
  });

  assert.equal(postflight.expectedJobs, 0);
  assert.equal(postflight.drained, true);
});
