import "server-only";

import { supabaseAdmin } from "@/lib/db/admin";
import { processR2CleanupQueue } from "@/lib/r2/processMediaCleanupQueue";
import type { NormalizedSubmissionPrivateData } from "@/lib/upload/submissionUploadRequest";

type RpcResult = Record<string, unknown>;

export type SubmissionUploadQuotaState = {
  used: number;
  limit: number;
  remaining: number;
  cooldownRemainingSeconds: number;
  nextUploadAllowedAt: string | null;
};

export type ReservedSubmissionUpload = {
  outcome: "reserved";
  operationId: string;
  cycleId: number;
  storageKey: string;
  r2Uploaded: boolean;
};

export type CompletedSubmissionUpload = {
  outcome: "completed" | "already_completed";
  operationId: string;
  cycleId: number;
  submissionId: number;
  socialSnapshotCount?: number;
} & Partial<SubmissionUploadQuotaState>;

export class SubmissionUploadSagaError extends Error {
  code: string;
  status: number;
  details: Partial<SubmissionUploadQuotaState>;

  constructor(
    code: string,
    status: number,
    details: Partial<SubmissionUploadQuotaState> = {}
  ) {
    super(code);
    this.name = "SubmissionUploadSagaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const OUTCOME_HTTP_ERRORS: Record<
  string,
  { code: string; status: number }
> = {
  not_authenticated: { code: "NOT_AUTHENTICATED", status: 401 },
  banned: { code: "BANNED", status: 403 },
  participation_unavailable: {
    code: "PARTICIPATION_UNAVAILABLE",
    status: 403,
  },
  not_in_discord: { code: "NOT_IN_DISCORD", status: 403 },
  joined_too_recently: {
    code: "JOINED_TOO_RECENTLY",
    status: 403,
  },
  rules_not_accepted: { code: "RULES_NOT_ACCEPTED", status: 403 },
  rate_limited: { code: "TOO_MANY_FAILED_UPLOADS", status: 429 },
  already_blocked: { code: "UPLOAD_BLOCKED_FOR_CYCLE", status: 403 },
  blocked: { code: "UPLOAD_BLOCKED_FOR_CYCLE", status: 403 },
  cycle_not_open: { code: "SUBMISSION_PHASE_CLOSED", status: 409 },
  upload_limit_reached: { code: "UPLOAD_LIMIT_REACHED", status: 409 },
  cooldown_active: { code: "UPLOAD_COOLDOWN_ACTIVE", status: 429 },
  upload_in_progress: { code: "UPLOAD_IN_PROGRESS", status: 409 },
  in_progress: { code: "UPLOAD_IN_PROGRESS", status: 409 },
  cleanup_pending: { code: "UPLOAD_CLEANUP_PENDING", status: 409 },
  cleanup_blocked: { code: "UPLOAD_CLEANUP_BLOCKED", status: 503 },
  idempotency_conflict: { code: "IDEMPOTENCY_CONFLICT", status: 409 },
  idempotency_cycle_conflict: {
    code: "IDEMPOTENCY_CYCLE_CONFLICT",
    status: 409,
  },
  profile_wallet_stale: { code: "PROFILE_WALLET_STALE", status: 409 },
  invalid_private_data: { code: "INVALID_PRIVATE_DATA", status: 422 },
  organization_unavailable: {
    code: "ORGANIZATION_UNAVAILABLE",
    status: 409,
  },
  invalid_media_metadata: { code: "INVALID_MEDIA_METADATA", status: 422 },
  invalid_request: { code: "INVALID_UPLOAD_REQUEST", status: 400 },
  invalid_state: { code: "UPLOAD_STATE_CONFLICT", status: 409 },
  not_found: { code: "UPLOAD_OPERATION_NOT_FOUND", status: 409 },
  dependency_unavailable: {
    code: "UPLOAD_DEPENDENCY_UNAVAILABLE",
    status: 503,
  },
};

function isRpcResult(value: unknown): value is RpcResult {
  return Boolean(value) && typeof value === "object";
}

function getOutcome(value: unknown) {
  if (!isRpcResult(value) || typeof value.outcome !== "string") {
    throw new SubmissionUploadSagaError(
      "UPLOAD_DEPENDENCY_UNAVAILABLE",
      503
    );
  }

  return value.outcome;
}

function getQuotaDetails(value: unknown): Partial<SubmissionUploadQuotaState> {
  if (!isRpcResult(value)) return {};

  return {
    ...(typeof value.used === "number" ? { used: value.used } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
    ...(typeof value.remaining === "number"
      ? { remaining: value.remaining }
      : {}),
    ...(typeof value.cooldownRemainingSeconds === "number"
      ? { cooldownRemainingSeconds: value.cooldownRemainingSeconds }
      : {}),
    ...(typeof value.nextUploadAllowedAt === "string" ||
    value.nextUploadAllowedAt === null
      ? { nextUploadAllowedAt: value.nextUploadAllowedAt }
      : {}),
  };
}

function throwForOutcome(outcome: string, value?: unknown): never {
  const mapped = OUTCOME_HTTP_ERRORS[outcome] ?? {
    code: "UPLOAD_DEPENDENCY_UNAVAILABLE",
    status: 503,
  };
  throw new SubmissionUploadSagaError(
    mapped.code,
    mapped.status,
    getQuotaDetails(value)
  );
}

function throwRpcFailure(
  stage: string,
  error: { code?: string; message?: string } | null
) {
  if (error?.message === "UPLOAD_BLOCKED_FOR_CYCLE") {
    throw new SubmissionUploadSagaError(
      "UPLOAD_BLOCKED_FOR_CYCLE",
      403
    );
  }

  if (error?.message?.includes("PARTICIPATION_UNAVAILABLE")) {
    throw new SubmissionUploadSagaError(
      "PARTICIPATION_UNAVAILABLE",
      403
    );
  }

  console.error("[submission upload saga][rpc]", {
    stage,
    code: error?.code ?? "UNKNOWN",
  });
  throw new SubmissionUploadSagaError(
    "UPLOAD_DEPENDENCY_UNAVAILABLE",
    503
  );
}

export async function getSubmissionUploadAbuseStatus({
  sessionId,
}: {
  sessionId: string;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "get_submission_upload_abuse_status",
    { p_session_id: sessionId }
  );

  if (error) throwRpcFailure("abuse-status", error);
  const outcome = getOutcome(data);

  if (outcome === "cycle_not_open") {
    return { cycleId: null, blocked: false, invalidAttemptCount: 0 };
  }
  if (
    outcome === "status" &&
    typeof data.cycleId === "number" &&
    typeof data.blocked === "boolean" &&
    typeof data.invalidAttemptCount === "number"
  ) {
    return {
      cycleId: data.cycleId,
      blocked: data.blocked,
      invalidAttemptCount: data.invalidAttemptCount,
    };
  }

  throwForOutcome(outcome);
}

export async function getCompletedSubmissionUploadOperation({
  sessionId,
  idempotencyKey,
}: {
  sessionId: string;
  idempotencyKey: string;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "get_completed_submission_upload_operation",
    {
      p_idempotency_key: idempotencyKey,
      p_session_id: sessionId,
    }
  );

  if (error) throwRpcFailure("completed-replay-check", error);
  const outcome = getOutcome(data);
  if (outcome === "not_found") return null;
  if (
    outcome !== "completed" ||
    typeof data.operationId !== "string" ||
    typeof data.cycleId !== "number" ||
    typeof data.submissionId !== "number"
  ) {
    throwForOutcome(outcome, data);
  }

  return {
    operationId: data.operationId,
    cycleId: data.cycleId,
    submissionId: data.submissionId,
  };
}

export async function registerInvalidSubmissionUpload({
  sessionId,
  cycleId,
  errorCode,
}: {
  sessionId: string;
  cycleId: number;
  errorCode: string;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "register_invalid_submission_upload",
    {
      p_cycle_id: cycleId,
      p_error_code: errorCode,
      p_session_id: sessionId,
    }
  );

  if (error) throwRpcFailure("register-invalid-media", error);
  const outcome = getOutcome(data);

  if (["counted", "blocked", "already_blocked"].includes(outcome)) {
    return {
      blocked: data.blocked === true,
      counted: outcome !== "already_blocked",
    };
  }
  if (["cycle_not_open", "not_countable"].includes(outcome)) {
    return { blocked: false, counted: false };
  }

  throwForOutcome(outcome, data);
}

export async function reserveSubmissionUpload({
  sessionId,
  idempotencyKey,
  requestFingerprint,
  contentSha256,
  mediaBytes,
  privateData,
}: {
  sessionId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  contentSha256: string;
  mediaBytes: number;
  privateData: NormalizedSubmissionPrivateData;
}): Promise<ReservedSubmissionUpload | CompletedSubmissionUpload> {
  const { data, error } = await supabaseAdmin.rpc(
    "reserve_submission_upload",
    {
      p_content_sha256: contentSha256,
      p_idempotency_key: idempotencyKey,
      p_media_bytes: mediaBytes,
      p_media_type: "image/webp",
      p_manual_wallet_address: privateData.manualWalletAddress,
      p_payout_choice: privateData.payoutChoice,
      p_profile_wallet_version: privateData.profileWalletVersion,
      p_request_fingerprint: requestFingerprint,
      p_session_id: sessionId,
      p_split_percent: privateData.splitPercent,
      p_charity: privateData.charity,
      p_wallet_source: privateData.walletSource,
    }
  );

  if (error) {
    throwRpcFailure("reserve", error);
  }

  const outcome = getOutcome(data);

  if (
    outcome === "already_completed" &&
    typeof data.operationId === "string" &&
    typeof data.cycleId === "number" &&
    typeof data.submissionId === "number"
  ) {
    return data as CompletedSubmissionUpload;
  }

  if (
    outcome === "reserved" &&
    typeof data.operationId === "string" &&
    typeof data.cycleId === "number" &&
    typeof data.storageKey === "string" &&
    typeof data.r2Uploaded === "boolean"
  ) {
    return data as ReservedSubmissionUpload;
  }

  throwForOutcome(outcome, data);
}

export async function markSubmissionUploadR2Uploaded({
  operationId,
  sessionId,
  etag,
}: {
  operationId: string;
  sessionId: string;
  etag: string | null;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "mark_submission_upload_r2_uploaded",
    {
      p_operation_id: operationId,
      p_r2_etag: etag,
      p_session_id: sessionId,
    }
  );

  if (error) {
    throwRpcFailure("mark-r2-uploaded", error);
  }

  const outcome = getOutcome(data);
  if (outcome === "r2_uploaded" || outcome === "already_completed") {
    return;
  }

  throwForOutcome(outcome, data);
}

export async function bindSubmissionUploadOrganization({
  operationId,
  sessionId,
  requestFingerprint,
  privateData,
}: {
  operationId: string;
  sessionId: string;
  requestFingerprint: string;
  privateData: NormalizedSubmissionPrivateData;
}) {
  const selection = privateData.organizationSelection;
  if (!selection) return;

  const { data, error } = await supabaseAdmin.rpc(
    "bind_submission_upload_organization",
    {
      p_operation_id: operationId,
      p_session_id: sessionId,
      p_request_fingerprint: requestFingerprint,
      p_source_type: selection.sourceType,
      p_public_key: selection.publicKey,
      p_other_name: selection.otherName,
      p_other_website_url: selection.otherWebsiteUrl,
    }
  );
  if (error) throwRpcFailure("bind-organization", error);
  const outcome = getOutcome(data);
  if (outcome !== "bound") throwForOutcome(outcome, data);
}

export async function commitSubmissionUpload({
  operationId,
  sessionId,
  mediaWidth,
  mediaHeight,
}: {
  operationId: string;
  sessionId: string;
  mediaWidth: number;
  mediaHeight: number;
}): Promise<CompletedSubmissionUpload> {
  const { data, error } = await supabaseAdmin.rpc(
    "commit_submission_upload",
    {
      p_media_height: mediaHeight,
      p_media_width: mediaWidth,
      p_operation_id: operationId,
      p_session_id: sessionId,
    }
  );

  if (error) {
    throwRpcFailure("commit", error);
  }

  const outcome = getOutcome(data);
  if (
    (outcome === "completed" || outcome === "already_completed") &&
    typeof data.operationId === "string" &&
    typeof data.cycleId === "number" &&
    typeof data.submissionId === "number"
  ) {
    return data as CompletedSubmissionUpload;
  }

  throwForOutcome(outcome, data);
}

export async function compensateSubmissionUpload({
  operationId,
  sessionId,
  errorCode,
}: {
  operationId: string;
  sessionId: string;
  errorCode: string;
}) {
  const { data, error } = await supabaseAdmin.rpc(
    "enqueue_submission_upload_cleanup",
    {
      p_error_code: errorCode,
      p_operation_id: operationId,
      p_session_id: sessionId,
    }
  );

  if (error) {
    console.error("[submission upload saga][compensation enqueue]", {
      code: error.code,
    });
    return { cleanupDurable: false, cleanupAttempted: false };
  }

  const outcome = getOutcome(data);
  if (outcome === "already_completed") {
    return { cleanupDurable: false, cleanupAttempted: false };
  }

  if (outcome !== "cleanup_pending") {
    console.error("[submission upload saga][compensation state]", {
      outcome,
    });
    return { cleanupDurable: false, cleanupAttempted: false };
  }

  try {
    await processR2CleanupQueue();
    return { cleanupDurable: true, cleanupAttempted: true };
  } catch (cleanupError) {
    console.error("[submission upload saga][cleanup start]", {
      errorName:
        cleanupError instanceof Error
          ? cleanupError.name
          : "UnknownError",
    });
    return { cleanupDurable: true, cleanupAttempted: false };
  }
}
