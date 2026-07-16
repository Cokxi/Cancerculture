export const MEDIA_CLEANUP_BATCH_SIZE = 10;
export const MEDIA_CLEANUP_CONCURRENCY = 4;
export const MEDIA_CLEANUP_LEASE_SECONDS = 120;

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
    claimed: jobs.length,
    completed: 0,
    deleted: 0,
    alreadyMissing: 0,
    retryScheduled: 0,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 0,
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
