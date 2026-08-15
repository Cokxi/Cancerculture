import "server-only";

import {
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import {
  createMediaCleanupError,
  drainDueMediaCleanupBatches,
  isMissingR2ObjectError,
  MEDIA_CLEANUP_BATCH_SIZE,
  MEDIA_CLEANUP_CONCURRENCY,
  MEDIA_CLEANUP_LEASE_SECONDS,
  processClaimedMediaCleanupJobs,
  processTargetedMediaCleanupBatches,
  verifyTargetedMediaCleanupPostflight,
  type ClaimedMediaCleanupJob,
  type MediaCleanupBatchResult,
  type MediaCleanupLeaseResult,
  type MediaCleanupQueuePostflightRow,
  type MediaDeleteOutcome,
} from "@/lib/r2/mediaCleanupState";
import { assertServerMutationAllowed } from "@/lib/writeGate.server";

function isClaimedJob(value: unknown): value is ClaimedMediaCleanupJob {
  if (!value || typeof value !== "object") {
    return false;
  }

  const job = value as Record<string, unknown>;
  return (
    typeof job.job_id === "number" &&
    typeof job.storage_provider === "string" &&
    typeof job.storage_key === "string" &&
    typeof job.lease_token === "string" &&
    typeof job.attempt_count === "number" &&
    typeof job.locked_until === "string"
  );
}

function isLeaseResult(value: unknown): value is MediaCleanupLeaseResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    [
      "completed",
      "retry_scheduled",
      "terminal_failure",
      "stale_lease",
      "not_found",
    ].includes(String(result.outcome)) &&
    typeof result.jobId === "number" &&
    (typeof result.status === "string" || result.status === null)
  );
}

function isUploadRecoveryResult(
  value: unknown
): value is { recovered: number; queued: number } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const result = value as Record<string, unknown>;
  return (
    typeof result.recovered === "number" &&
    typeof result.queued === "number"
  );
}

async function recoverStaleSubmissionUploads() {
  const { data, error } = await supabaseAdmin.rpc(
    "recover_stale_submission_uploads",
    {
      p_limit: 100,
      p_stale_after_seconds: 900,
    }
  );

  if (error) {
    console.error("[media cleanup][upload recovery]", {
      code: error.code,
    });
    throw new Error("Stale submission uploads could not be recovered");
  }

  if (!isUploadRecoveryResult(data)) {
    throw new Error(
      "Stale submission upload recovery returned an invalid response"
    );
  }

  return data;
}

async function claimDueJobs() {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_media_cleanup_jobs",
    {
      p_lease_seconds: MEDIA_CLEANUP_LEASE_SECONDS,
      p_limit: MEDIA_CLEANUP_BATCH_SIZE,
    }
  );

  if (error) {
    console.error("[media cleanup][claim]", { code: error.code });
    throw new Error("Media cleanup jobs could not be claimed");
  }

  if (!Array.isArray(data) || !data.every(isClaimedJob)) {
    console.error("[media cleanup][claim response invalid]");
    throw new Error("Media cleanup claim returned an invalid response");
  }

  return data;
}

async function recoverStaleSponsorUploads() {
  const { data, error } = await supabaseAdmin.rpc(
    "recover_stale_sponsor_media_uploads",
    { p_limit: 100 }
  );
  if (error) {
    console.error("[media cleanup][sponsor upload recovery]", {
      code: error.code,
    });
    throw new Error("Stale Sponsor uploads could not be recovered");
  }
  if (!isUploadRecoveryResult(data)) {
    throw new Error(
      "Stale Sponsor upload recovery returned an invalid response"
    );
  }
  return data;
}

async function claimDueJobsByIds(queueIds: readonly number[]) {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_media_cleanup_jobs_by_ids",
    {
      p_job_ids: queueIds,
      p_lease_seconds: MEDIA_CLEANUP_LEASE_SECONDS,
    }
  );

  if (error) {
    console.error("[media cleanup][targeted claim]", {
      code: error.code,
      requestedCount: queueIds.length,
    });
    throw new Error("Targeted media cleanup jobs could not be claimed");
  }

  if (!Array.isArray(data) || !data.every(isClaimedJob)) {
    console.error("[media cleanup][targeted claim response invalid]");
    throw new Error("Targeted media cleanup claim returned an invalid response");
  }

  return data;
}

async function completeJob(job: ClaimedMediaCleanupJob) {
  const { data, error } = await supabaseAdmin.rpc(
    "complete_media_cleanup_job",
    {
      p_job_id: job.job_id,
      p_lease_token: job.lease_token,
    }
  );

  if (error) {
    console.error("[media cleanup][complete]", {
      code: error.code,
      queueId: job.job_id,
    });
    throw new Error("Media cleanup completion could not be confirmed");
  }

  if (!isLeaseResult(data)) {
    throw new Error("Media cleanup completion returned an invalid response");
  }

  return data;
}

async function failJob(
  job: ClaimedMediaCleanupJob,
  failure: { errorCode: string; permanent: boolean }
) {
  const { data, error } = await supabaseAdmin.rpc(
    "fail_media_cleanup_job",
    {
      p_error_code: failure.errorCode,
      p_job_id: job.job_id,
      p_lease_token: job.lease_token,
      p_permanent: failure.permanent,
    }
  );

  if (error) {
    console.error("[media cleanup][fail]", {
      code: error.code,
      queueId: job.job_id,
    });
    throw new Error("Media cleanup failure could not be confirmed");
  }

  if (!isLeaseResult(data)) {
    throw new Error("Media cleanup failure returned an invalid response");
  }

  return data;
}

function assertR2Configuration() {
  const requiredValues = [
    process.env.R2_ACCOUNT_ID,
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
    process.env.R2_BUCKET_NAME,
  ];

  if (requiredValues.some((value) => !value)) {
    throw createMediaCleanupError("R2_NOT_CONFIGURED", {
      permanent: true,
    });
  }

  return process.env.R2_BUCKET_NAME as string;
}

async function deleteQueuedR2Object(
  job: ClaimedMediaCleanupJob
): Promise<MediaDeleteOutcome> {
  const bucket = assertR2Configuration();

  try {
    await r2.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: job.storage_key,
      })
    );
  } catch (error) {
    if (isMissingR2ObjectError(error)) {
      return "already_missing";
    }

    throw error;
  }

  await r2.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: job.storage_key,
    })
  );
  return "deleted";
}

async function processClaimedJobs(jobs: ClaimedMediaCleanupJob[]) {
  return processClaimedMediaCleanupJobs({
    jobs,
    concurrency: MEDIA_CLEANUP_CONCURRENCY,
    deleteObject: deleteQueuedR2Object,
    completeJob,
    failJob,
  });
}

export async function processR2CleanupQueue(
  options: { queueIds?: readonly number[] } = {}
): Promise<MediaCleanupBatchResult> {
  assertServerMutationAllowed({ allowDrain: true });
  const queueIds = options.queueIds;
  let jobs: ClaimedMediaCleanupJob[];

  if (queueIds) {
    if (queueIds.length < 1 || queueIds.length > MEDIA_CLEANUP_BATCH_SIZE) {
      throw new TypeError("Invalid targeted media cleanup batch");
    }
    jobs = await claimDueJobsByIds(queueIds);
  } else {
    await Promise.all([
      recoverStaleSubmissionUploads(),
      recoverStaleSponsorUploads(),
    ]);
    jobs = await claimDueJobs();
  }

  return processClaimedJobs(jobs);
}

export async function processDueR2CleanupQueue() {
  assertServerMutationAllowed({ allowDrain: true });
  const [recovery, sponsorRecovery] = await Promise.all([
    recoverStaleSubmissionUploads(),
    recoverStaleSponsorUploads(),
  ]);
  const result = await drainDueMediaCleanupBatches({
    processBatch: async () => processClaimedJobs(await claimDueJobs()),
  });

  return {
    ...result,
    recoveredUploads: recovery.recovered,
    queuedFromRecovery: recovery.queued,
    recoveredSponsorUploads: sponsorRecovery.recovered,
    queuedFromSponsorRecovery: sponsorRecovery.queued,
  };
}

export async function processTargetedR2CleanupQueue(
  queueIds: readonly number[]
) {
  assertServerMutationAllowed({ allowDrain: true });
  const result = await processTargetedMediaCleanupBatches({
    queueIds,
    processBatch: async (batch) =>
      processClaimedJobs(await claimDueJobsByIds(batch)),
  });

  if (result.batchFailures > 0) {
    console.error("[media cleanup][targeted drain incomplete]", {
      batchFailures: result.batchFailures,
      batchesAttempted: result.batchesAttempted,
    });
  }

  return result;
}

async function countQueueRows({
  statuses,
  dueColumn,
  dueAt,
}: {
  statuses: readonly string[];
  dueColumn?: "next_attempt_at" | "locked_until";
  dueAt?: string;
}) {
  let query = supabaseAdmin
    .from("media_cleanup_queue")
    .select("id", { count: "exact", head: true })
    .in("status", statuses);

  if (dueColumn && dueAt) {
    query = query.lte(dueColumn, dueAt);
  }

  const { count, error } = await query;
  if (error || typeof count !== "number") {
    console.error("[media cleanup][queue health]", {
      code: error?.code ?? "INVALID_COUNT",
    });
    throw new Error("Media cleanup queue health could not be read");
  }

  return count;
}

export async function getMediaCleanupQueueHealth() {
  const now = new Date().toISOString();
  const [retryPending, dueRetryPending, processing, expiredProcessing, dead] =
    await Promise.all([
      countQueueRows({ statuses: ["pending", "failed"] }),
      countQueueRows({
        statuses: ["pending", "failed"],
        dueColumn: "next_attempt_at",
        dueAt: now,
      }),
      countQueueRows({ statuses: ["processing"] }),
      countQueueRows({
        statuses: ["processing"],
        dueColumn: "locked_until",
        dueAt: now,
      }),
      countQueueRows({ statuses: ["dead"] }),
    ]);

  return {
    retryPending,
    dueRetryPending,
    processing,
    expiredProcessing,
    dead,
    outstanding: retryPending + processing + dead,
  };
}

function isPostflightRow(value: unknown): value is MediaCleanupQueuePostflightRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "number" &&
    typeof row.storage_provider === "string" &&
    typeof row.storage_key === "string" &&
    typeof row.status === "string"
  );
}

export async function verifyR2CleanupQueuePostflight(
  queueIds: readonly number[]
) {
  if (queueIds.length === 0) {
    return verifyTargetedMediaCleanupPostflight({
      queueIds,
      rows: [],
      probeObject: async () => "missing",
    });
  }

  const { data, error } = await supabaseAdmin
    .from("media_cleanup_queue")
    .select("id, storage_provider, storage_key, status")
    .in("id", queueIds);

  if (error || !Array.isArray(data) || !data.every(isPostflightRow)) {
    console.error("[media cleanup][targeted postflight]", {
      code: error?.code ?? "INVALID_RESPONSE",
    });
    throw new Error("Targeted media cleanup postflight could not be read");
  }

  return verifyTargetedMediaCleanupPostflight({
    queueIds,
    rows: data,
    probeObject: async (row) => {
      const bucket = assertR2Configuration();
      try {
        await r2.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: row.storage_key,
          })
        );
        return "present";
      } catch (probeError) {
        if (isMissingR2ObjectError(probeError)) return "missing";
        throw probeError;
      }
    },
  });
}
