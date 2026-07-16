import "server-only";

import {
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { supabaseAdmin } from "@/lib/db/admin";
import { r2 } from "@/lib/r2";
import {
  createMediaCleanupError,
  isMissingR2ObjectError,
  MEDIA_CLEANUP_BATCH_SIZE,
  MEDIA_CLEANUP_CONCURRENCY,
  MEDIA_CLEANUP_LEASE_SECONDS,
  processClaimedMediaCleanupJobs,
  type ClaimedMediaCleanupJob,
  type MediaCleanupBatchResult,
  type MediaCleanupLeaseResult,
  type MediaDeleteOutcome,
} from "@/lib/r2/mediaCleanupState";

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

export async function processR2CleanupQueue(): Promise<MediaCleanupBatchResult> {
  await recoverStaleSubmissionUploads();
  const jobs = await claimDueJobs();

  return processClaimedMediaCleanupJobs({
    jobs,
    concurrency: MEDIA_CLEANUP_CONCURRENCY,
    deleteObject: deleteQueuedR2Object,
    completeJob,
    failJob,
  });
}
