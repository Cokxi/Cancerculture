import assert from "node:assert/strict";
import test from "node:test";
import {
  createMediaCleanupError,
  isCanonicalQueuedStorageKey,
  isMissingR2ObjectError,
  processClaimedMediaCleanupJobs,
  sanitizeMediaCleanupErrorCode,
} from "../../lib/r2/mediaCleanupState.ts";

function job(id, storageKey = `cycle/${id}.webp`) {
  return {
    job_id: id,
    storage_provider: "r2",
    storage_key: storageKey,
    lease_token: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    attempt_count: 1,
    locked_until: "2099-01-01T00:00:00.000Z",
  };
}

function leaseResult(outcome, claimedJob) {
  const statuses = {
    completed: "completed",
    retry_scheduled: "failed",
    terminal_failure: "dead",
    stale_lease: "processing",
    not_found: null,
  };

  return {
    outcome,
    jobId: claimedJob.job_id,
    status: statuses[outcome],
  };
}

test("canonical queue keys are structural and provider-neutral", () => {
  for (const valid of [
    "4/00000000-0000-4000-8000-000000000004.webp",
    "sponsored-cycles/drafts/banner.webp",
    "future-media-type/asset-01.bin",
  ]) {
    assert.equal(isCanonicalQueuedStorageKey(valid), true, valid);
  }

  for (const invalid of [
    "",
    " /asset.webp",
    "/asset.webp",
    "folder//asset.webp",
    "folder/../asset.webp",
    "folder\\asset.webp",
    "https://example.invalid/asset.webp",
    "asset.webp?signature=secret",
    "asset.webp#fragment",
    "asset\u0000.webp",
  ]) {
    assert.equal(isCanonicalQueuedStorageKey(invalid), false, invalid);
  }
});

test("missing-object errors are recognized without treating other failures as missing", () => {
  assert.equal(isMissingR2ObjectError({ name: "NotFound" }), true);
  assert.equal(isMissingR2ObjectError({ name: "NoSuchKey" }), true);
  assert.equal(
    isMissingR2ObjectError({ $metadata: { httpStatusCode: 404 } }),
    true
  );
  assert.equal(
    isMissingR2ObjectError({ $metadata: { httpStatusCode: 503 } }),
    false
  );
});

test("bounded workers allow partial success, missing success, and retry scheduling", async () => {
  const jobs = Array.from({ length: 9 }, (_, index) => job(index + 1));
  let active = 0;
  let maximumActive = 0;

  const result = await processClaimedMediaCleanupJobs({
    jobs,
    concurrency: 99,
    deleteObject: async (claimedJob) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;

      if (claimedJob.job_id === 3) {
        const providerError = new Error("raw provider details");
        providerError.name = "ServiceUnavailable";
        throw providerError;
      }

      return claimedJob.job_id === 4 ? "already_missing" : "deleted";
    },
    completeJob: async (claimedJob) =>
      leaseResult("completed", claimedJob),
    failJob: async (claimedJob, failure) => {
      assert.equal(failure.errorCode, "ServiceUnavailable");
      assert.equal(failure.permanent, false);
      return leaseResult("retry_scheduled", claimedJob);
    },
  });

  assert.equal(maximumActive <= 4, true);
  assert.deepEqual(result, {
    claimed: 9,
    completed: 8,
    deleted: 7,
    alreadyMissing: 1,
    retryScheduled: 1,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 1,
  });
});

test("invalid keys and permanent configuration errors become terminal without deleting", async () => {
  let deleteCalls = 0;
  const failures = [];

  const result = await processClaimedMediaCleanupJobs({
    jobs: [job(1, "../unsafe.webp"), job(2)],
    deleteObject: async (claimedJob) => {
      deleteCalls += 1;
      if (claimedJob.job_id === 2) {
        throw createMediaCleanupError("R2_NOT_CONFIGURED", {
          permanent: true,
        });
      }
      return "deleted";
    },
    completeJob: async (claimedJob) =>
      leaseResult("completed", claimedJob),
    failJob: async (claimedJob, failure) => {
      failures.push({ id: claimedJob.job_id, ...failure });
      return leaseResult("terminal_failure", claimedJob);
    },
  });

  assert.equal(deleteCalls, 1);
  assert.deepEqual(failures, [
    { id: 1, errorCode: "INVALID_STORAGE_KEY", permanent: true },
    { id: 2, errorCode: "R2_NOT_CONFIGURED", permanent: true },
  ]);
  assert.equal(result.terminalFailures, 2);
  assert.equal(result.deletionFailures, 1);
});

test("stale and failed confirmations do not count as completed deletes", async () => {
  const result = await processClaimedMediaCleanupJobs({
    jobs: [job(1), job(2)],
    deleteObject: async () => "deleted",
    completeJob: async (claimedJob) => {
      if (claimedJob.job_id === 1) {
        return leaseResult("stale_lease", claimedJob);
      }
      throw new Error("database unavailable");
    },
    failJob: async (claimedJob) =>
      leaseResult("retry_scheduled", claimedJob),
  });

  assert.equal(result.completed, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.staleResults, 1);
  assert.equal(result.confirmationFailures, 1);
});

test("provider error codes are sanitized and bounded", () => {
  const error = new Error("ignored raw message");
  error.name = `bad code ${"x".repeat(200)}`;
  const code = sanitizeMediaCleanupErrorCode(error);

  assert.equal(code.length, 120);
  assert.match(code, /^[A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(code, /ignored raw message/);
});
