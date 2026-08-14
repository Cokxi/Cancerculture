export const MEDIA_CLEANUP_BATCH_SIZE = 10;
export const MEDIA_CLEANUP_CONCURRENCY = 4;
export const MEDIA_CLEANUP_LEASE_SECONDS = 120;
export const MEDIA_CLEANUP_MAX_DUE_BATCHES = 10;

export type ClaimedMediaCleanupJob = {
  job_id: number;
  storage_provider: string;
  storage_key: string;
  lease_token: string;
  attempt_count: number;
  locked_until: string;
};

export type MediaDeleteOutcome = "deleted" | "already_missing";

export type MediaCleanupLeaseResult = {
  outcome:
    | "completed"
    | "retry_scheduled"
    | "terminal_failure"
    | "stale_lease"
    | "not_found";
  jobId: number;
  status: string | null;
  attemptCount?: number;
  nextAttemptAt?: string | null;
};

export type MediaCleanupBatchResult = {
  claimed: number;
  completed: number;
  deleted: number;
  alreadyMissing: number;
  retryScheduled: number;
  terminalFailures: number;
  staleResults: number;
  confirmationFailures: number;
  deletionFailures: number;
};

export type MediaCleanupRunResult = MediaCleanupBatchResult & {
  batchesAttempted: number;
  batchFailures: number;
  drainComplete: boolean;
};

export type MediaCleanupQueuePostflight = {
  expectedJobs: number;
  completedQueueJobs: number;
  retryableQueueJobs: number;
  processingQueueJobs: number;
  terminalQueueJobs: number;
  missingQueueJobs: number;
  unexpectedQueueRows: number;
  objectsMissing: number;
  objectsPresent: number;
  objectVerificationFailures: number;
  drained: boolean;
};

export type MediaCleanupQueuePostflightRow = {
  id: number;
  storage_provider: string;
  storage_key: string;
  status: string;
};

type CleanupFailure = Error & {
  cleanupCode?: string;
  permanent?: boolean;
};

export function createMediaCleanupError(
  code: string,
  { permanent = false }: { permanent?: boolean } = {}
) {
  const error = new Error(code) as CleanupFailure;
  error.name = "MediaCleanupError";
  error.cleanupCode = code;
  error.permanent = permanent;
  return error;
}

export function sanitizeMediaCleanupErrorCode(error: unknown) {
  const cleanupError = error as CleanupFailure | null;
  const candidate =
    cleanupError?.cleanupCode ??
    (error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "R2_DELETE_FAILED");
  const sanitized = candidate.replace(/[^A-Za-z0-9_.-]/g, "_");

  return (sanitized || "R2_DELETE_FAILED").slice(0, 120);
}

export function isPermanentMediaCleanupError(error: unknown) {
  return Boolean((error as CleanupFailure | null)?.permanent);
}

export function isMissingR2ObjectError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export function isCanonicalQueuedStorageKey(storageKey: string) {
  if (
    storageKey.length === 0 ||
    storageKey.length > 1024 ||
    storageKey !== storageKey.trim() ||
    storageKey.startsWith("/") ||
    storageKey.includes("\\") ||
    storageKey.includes("?") ||
    storageKey.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(storageKey) ||
    storageKey.includes("://")
  ) {
    return false;
  }

  const segments = storageKey.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  );
}

export function createEmptyMediaCleanupBatchResult(): MediaCleanupBatchResult {
  return {
    claimed: 0,
    completed: 0,
    deleted: 0,
    alreadyMissing: 0,
    retryScheduled: 0,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 0,
  };
}

export function mergeMediaCleanupBatchResult(
  aggregate: MediaCleanupBatchResult,
  batch: MediaCleanupBatchResult
) {
  for (const key of Object.keys(
    createEmptyMediaCleanupBatchResult()
  ) as Array<keyof MediaCleanupBatchResult>) {
    aggregate[key] += batch[key];
  }
}

function createEmptyMediaCleanupRunResult(): MediaCleanupRunResult {
  return {
    ...createEmptyMediaCleanupBatchResult(),
    batchesAttempted: 0,
    batchFailures: 0,
    drainComplete: false,
  };
}

export function chunkTargetedMediaCleanupQueueIds(
  queueIds: readonly number[]
) {
  if (
    queueIds.some(
      (queueId) => !Number.isSafeInteger(queueId) || queueId <= 0
    ) ||
    new Set(queueIds).size !== queueIds.length
  ) {
    throw new TypeError("Invalid targeted media cleanup jobs");
  }

  const batches: number[][] = [];
  for (let index = 0; index < queueIds.length; index += MEDIA_CLEANUP_BATCH_SIZE) {
    batches.push(queueIds.slice(index, index + MEDIA_CLEANUP_BATCH_SIZE));
  }
  return batches;
}

export async function drainDueMediaCleanupBatches({
  processBatch,
  maxBatches = MEDIA_CLEANUP_MAX_DUE_BATCHES,
}: {
  processBatch: () => Promise<MediaCleanupBatchResult>;
  maxBatches?: number;
}): Promise<MediaCleanupRunResult> {
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new TypeError("Invalid media cleanup drain limit");
  }

  const result = createEmptyMediaCleanupRunResult();

  for (let index = 0; index < maxBatches; index += 1) {
    const batch = await processBatch();
    result.batchesAttempted += 1;
    mergeMediaCleanupBatchResult(result, batch);

    if (batch.claimed < MEDIA_CLEANUP_BATCH_SIZE) {
      result.drainComplete = true;
      return result;
    }
  }

  return result;
}

export async function processTargetedMediaCleanupBatches({
  queueIds,
  processBatch,
}: {
  queueIds: readonly number[];
  processBatch: (batch: readonly number[]) => Promise<MediaCleanupBatchResult>;
}): Promise<MediaCleanupRunResult> {
  const batches = chunkTargetedMediaCleanupQueueIds(queueIds);
  const result = createEmptyMediaCleanupRunResult();

  for (const batch of batches) {
    result.batchesAttempted += 1;
    try {
      mergeMediaCleanupBatchResult(result, await processBatch(batch));
    } catch {
      result.batchFailures += 1;
      return result;
    }
  }

  result.drainComplete = true;
  return result;
}

export async function verifyTargetedMediaCleanupPostflight({
  queueIds,
  rows,
  probeObject,
}: {
  queueIds: readonly number[];
  rows: readonly MediaCleanupQueuePostflightRow[];
  probeObject: (
    row: MediaCleanupQueuePostflightRow
  ) => Promise<"missing" | "present">;
}): Promise<MediaCleanupQueuePostflight> {
  chunkTargetedMediaCleanupQueueIds(queueIds);
  const expectedIds = new Set(queueIds);
  const rowsById = new Map<number, MediaCleanupQueuePostflightRow>();
  let unexpectedQueueRows = 0;

  for (const row of rows) {
    if (!expectedIds.has(row.id) || rowsById.has(row.id)) {
      unexpectedQueueRows += 1;
      continue;
    }
    rowsById.set(row.id, row);
  }

  const postflight: MediaCleanupQueuePostflight = {
    expectedJobs: queueIds.length,
    completedQueueJobs: 0,
    retryableQueueJobs: 0,
    processingQueueJobs: 0,
    terminalQueueJobs: 0,
    missingQueueJobs: 0,
    unexpectedQueueRows,
    objectsMissing: 0,
    objectsPresent: 0,
    objectVerificationFailures: 0,
    drained: false,
  };

  const probeRows: MediaCleanupQueuePostflightRow[] = [];

  for (const queueId of queueIds) {
    const row = rowsById.get(queueId);
    if (!row) {
      postflight.missingQueueJobs += 1;
      continue;
    }

    if (row.status === "completed") {
      postflight.completedQueueJobs += 1;
    } else if (row.status === "pending" || row.status === "failed") {
      postflight.retryableQueueJobs += 1;
    } else if (row.status === "processing") {
      postflight.processingQueueJobs += 1;
    } else {
      postflight.terminalQueueJobs += 1;
    }

    if (
      row.storage_provider === "r2" &&
      isCanonicalQueuedStorageKey(row.storage_key)
    ) {
      probeRows.push(row);
    } else {
      postflight.objectVerificationFailures += 1;
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const row = probeRows[nextIndex];
      nextIndex += 1;
      if (!row) return;

      try {
        const outcome = await probeObject(row);
        if (outcome === "missing") {
          postflight.objectsMissing += 1;
        } else {
          postflight.objectsPresent += 1;
        }
      } catch {
        postflight.objectVerificationFailures += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MEDIA_CLEANUP_CONCURRENCY, probeRows.length) },
      () => worker()
    )
  );

  postflight.drained =
    postflight.completedQueueJobs === postflight.expectedJobs &&
    postflight.objectsMissing === postflight.expectedJobs &&
    postflight.retryableQueueJobs === 0 &&
    postflight.processingQueueJobs === 0 &&
    postflight.terminalQueueJobs === 0 &&
    postflight.missingQueueJobs === 0 &&
    postflight.unexpectedQueueRows === 0 &&
    postflight.objectsPresent === 0 &&
    postflight.objectVerificationFailures === 0;

  return postflight;
}

function recordLeaseResult(
  aggregate: MediaCleanupBatchResult,
  result: MediaCleanupLeaseResult
) {
  if (result.outcome === "completed") {
    aggregate.completed += 1;
    return;
  }

  if (result.outcome === "retry_scheduled") {
    aggregate.retryScheduled += 1;
    return;
  }

  if (result.outcome === "terminal_failure") {
    aggregate.terminalFailures += 1;
    return;
  }

  aggregate.staleResults += 1;
}

export async function processClaimedMediaCleanupJobs({
  jobs,
  deleteObject,
  completeJob,
  failJob,
  concurrency = MEDIA_CLEANUP_CONCURRENCY,
}: {
  jobs: ClaimedMediaCleanupJob[];
  deleteObject: (
    job: ClaimedMediaCleanupJob
  ) => Promise<MediaDeleteOutcome>;
  completeJob: (
    job: ClaimedMediaCleanupJob
  ) => Promise<MediaCleanupLeaseResult>;
  failJob: (
    job: ClaimedMediaCleanupJob,
    failure: { errorCode: string; permanent: boolean }
  ) => Promise<MediaCleanupLeaseResult>;
  concurrency?: number;
}): Promise<MediaCleanupBatchResult> {
  const aggregate: MediaCleanupBatchResult = {
    ...createEmptyMediaCleanupBatchResult(),
    claimed: jobs.length,
  };

  if (jobs.length === 0) {
    return aggregate;
  }

  const workerCount = Math.max(
    1,
    Math.min(Math.floor(concurrency), MEDIA_CLEANUP_CONCURRENCY, jobs.length)
  );
  let nextIndex = 0;

  async function processOne(job: ClaimedMediaCleanupJob) {
    if (
      job.storage_provider !== "r2" ||
      !isCanonicalQueuedStorageKey(job.storage_key)
    ) {
      try {
        const result = await failJob(job, {
          errorCode:
            job.storage_provider !== "r2"
              ? "UNSUPPORTED_STORAGE_PROVIDER"
              : "INVALID_STORAGE_KEY",
          permanent: true,
        });
        recordLeaseResult(aggregate, result);
      } catch {
        aggregate.confirmationFailures += 1;
      }
      return;
    }

    let deleteOutcome: MediaDeleteOutcome;

    try {
      deleteOutcome = await deleteObject(job);
    } catch (error) {
      aggregate.deletionFailures += 1;

      try {
        const result = await failJob(job, {
          errorCode: sanitizeMediaCleanupErrorCode(error),
          permanent: isPermanentMediaCleanupError(error),
        });
        recordLeaseResult(aggregate, result);
      } catch {
        aggregate.confirmationFailures += 1;
      }
      return;
    }

    try {
      const result = await completeJob(job);
      recordLeaseResult(aggregate, result);

      if (result.outcome === "completed") {
        if (deleteOutcome === "already_missing") {
          aggregate.alreadyMissing += 1;
        } else {
          aggregate.deleted += 1;
        }
      }
    } catch {
      aggregate.confirmationFailures += 1;
    }
  }

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= jobs.length) {
        return;
      }

      await processOne(jobs[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return aggregate;
}
