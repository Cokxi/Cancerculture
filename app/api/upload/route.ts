export const runtime = "nodejs";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { requireParticipation } from "@/lib/auth/participationGuard";
import { logUpload } from "@/lib/logging/logUpload";
import { touchUserLog } from "@/lib/logging/touchUserLog";
import {
  isCountableSubmissionMediaErrorCode,
  SUBMISSION_MEDIA_PROFILE,
} from "@/lib/media/profiles";
import {
  MediaValidationError,
  processStaticImage,
} from "@/lib/media/processStaticImage";
import { r2 } from "@/lib/r2";
import { isCanonicalQueuedStorageKey } from "@/lib/r2/mediaCleanupState";
import {
  getUploadEligibility,
  UploadEligibilityDependencyError,
} from "@/lib/upload/getUploadEligibility";
import {
  createSubmissionContentHash,
  createSubmissionUploadFingerprint,
  normalizeSubmissionPrivateData,
  parseSubmissionUploadIdempotencyKey,
  SUBMISSION_UPLOAD_IDEMPOTENCY_HEADER,
  SubmissionUploadRequestError,
} from "@/lib/upload/submissionUploadRequest";
import {
  commitSubmissionUpload,
  compensateSubmissionUpload,
  getSubmissionUploadAbuseStatus,
  getCompletedSubmissionUploadOperation,
  markSubmissionUploadR2Uploaded,
  registerInvalidSubmissionUpload,
  reserveSubmissionUpload,
  SubmissionUploadSagaError,
} from "@/lib/upload/submissionUploadSaga";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";

const PRIVATE_UPLOAD_CACHE_CONTROL = "no-store, max-age=0";

function uploadJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", PRIVATE_UPLOAD_CACHE_CONTROL);
  headers.set("Pragma", "no-cache");
  return NextResponse.json(body, { ...init, headers });
}

async function failUpload({
  discordUserId,
  cycleId = null,
  reason,
  error,
  status,
  joinedAt,
}: {
  discordUserId: string | null;
  cycleId?: number | null;
  reason: string;
  error: string;
  status: number;
  joinedAt?: string | null;
}) {
  await Promise.allSettled([
    logUpload({
      cycleId,
      discordUserId,
      status: "failed",
      reason,
    }),
  ]);

  return uploadJson(
    joinedAt ? { error, joinedAt } : { error },
    { status }
  );
}

function providerErrorCode(error: unknown) {
  if (error && typeof error === "object" && "name" in error) {
    return String(error.name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  }

  return "R2_UPLOAD_FAILED";
}

function cooldownResponse({
  used,
  limit,
  remaining,
  cooldownRemainingSeconds,
  nextUploadAllowedAt,
}: {
  used?: number;
  limit?: number;
  remaining?: number;
  cooldownRemainingSeconds?: number;
  nextUploadAllowedAt?: string | null;
}) {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(cooldownRemainingSeconds ?? 1)
  );

  return uploadJson(
    {
      error: "UPLOAD_COOLDOWN_ACTIVE",
      retryAfterSeconds,
      used,
      limit,
      remaining,
      nextUploadAllowedAt: nextUploadAllowedAt ?? null,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    }
  );
}

export async function POST(req: Request) {
  let discordUserId: string | null = null;
  let sessionId: string | null = null;
  let operationId: string | null = null;
  let cycleId: number | null = null;
  let r2WriteAttempted = false;
  let compensationStarted = false;

  const compensateOnce = async (errorCode: string) => {
    if (
      compensationStarted ||
      !r2WriteAttempted ||
      !operationId ||
      !sessionId
    ) {
      return;
    }

    compensationStarted = true;
    await compensateSubmissionUpload({
      operationId,
      sessionId,
      errorCode,
    });
  };

  try {
    const { session } = await requireParticipation();
    const authenticatedDiscordUserId = session.discord_user_id;
    discordUserId = authenticatedDiscordUserId;
    sessionId = session.session_id;

    const [uploadEligibility, abuseStatus] = await Promise.all([
      getUploadEligibility({
        discordUserId: authenticatedDiscordUserId,
        includeDiscordMembership: false,
      }),
      getSubmissionUploadAbuseStatus({ sessionId }),
    ]);

    if (uploadEligibility.isBanned) {
      return failUpload({
        discordUserId,
        reason: "banned",
        error: "BANNED",
        status: 403,
      });
    }

    if (!uploadEligibility.hasAcceptedRules) {
      return failUpload({
        discordUserId,
        reason: "rules_not_accepted",
        error: "RULES_NOT_ACCEPTED",
        status: 403,
      });
    }

    if (uploadEligibility.isUploadBlocked || abuseStatus.blocked) {
      return failUpload({
        discordUserId,
        cycleId: abuseStatus.cycleId ?? uploadEligibility.activeCycleId,
        reason: "upload_blocked_for_cycle",
        error: "UPLOAD_BLOCKED_FOR_CYCLE",
        status: 403,
      });
    }

    if (!uploadEligibility.activeCycleId) {
      return failUpload({
        discordUserId,
        reason: "cycle_not_open",
        error: "SUBMISSION_PHASE_CLOSED",
        status: 409,
      });
    }

    const idempotencyKey = parseSubmissionUploadIdempotencyKey(
      req.headers.get(SUBMISSION_UPLOAD_IDEMPOTENCY_HEADER)
    );
    const completedReplay =
      await getCompletedSubmissionUploadOperation({
        sessionId,
        idempotencyKey,
      });

    const isCompletedReplay =
      completedReplay?.cycleId === uploadEligibility.activeCycleId;

    if (!isCompletedReplay && uploadEligibility.quota?.remaining === 0) {
      return failUpload({
        discordUserId,
        cycleId: uploadEligibility.activeCycleId,
        reason: "upload_limit_reached",
        error: "UPLOAD_LIMIT_REACHED",
        status: 409,
      });
    }

    if (
      !isCompletedReplay &&
      (uploadEligibility.quota?.cooldownRemainingSeconds ?? 0) > 0
    ) {
      return cooldownResponse(uploadEligibility.quota ?? {});
    }

    const turnstileResult = await verifyTurnstileRequest(
      req,
      TURNSTILE_ACTIONS.submissionUpload
    );

    if (turnstileResult.status === "rejected") {
      return uploadJson(
        { error: turnstileResult.code },
        { status: 400 }
      );
    }

    if (turnstileResult.status === "configuration_error") {
      return uploadJson(
        { error: turnstileResult.code },
        { status: 503 }
      );
    }

    cycleId = uploadEligibility.activeCycleId;

    await touchUserLog({
      discordUserId: authenticatedDiscordUserId,
      throwOnError: true,
    });

    const formData = await req.formData();
    const fileEntry = formData.get("file");

    if (!(fileEntry instanceof File)) {
      throw new SubmissionUploadRequestError("NO_FILE");
    }

    if (fileEntry.size > SUBMISSION_MEDIA_PROFILE.maxInputBytes) {
      throw new MediaValidationError("MEDIA_FILE_TOO_LARGE", 413);
    }

    const privateData = normalizeSubmissionPrivateData(formData);
    const inputBuffer = Buffer.from(await fileEntry.arrayBuffer());
    const processedImage = await processStaticImage({
      input: inputBuffer,
      claimedMimeType: fileEntry.type,
      profile: SUBMISSION_MEDIA_PROFILE,
    });
    const webpBuffer = processedImage.buffer;

    const contentSha256 = createSubmissionContentHash(webpBuffer);
    const requestFingerprint = createSubmissionUploadFingerprint({
      contentSha256,
      privateData,
    });
    const reservation = await reserveSubmissionUpload({
      sessionId,
      idempotencyKey,
      requestFingerprint,
      contentSha256,
      mediaBytes: webpBuffer.byteLength,
      privateData,
    });

    if (reservation.outcome === "already_completed") {
      return uploadJson({
        success: true,
        alreadyCompleted: true,
        submissionId: reservation.submissionId,
        ...uploadEligibility.quota,
      });
    }

    if (reservation.outcome !== "reserved") {
      throw new SubmissionUploadSagaError(
        "UPLOAD_STATE_CONFLICT",
        409
      );
    }

    operationId = reservation.operationId;
    cycleId = reservation.cycleId;

    if (
      !isCanonicalQueuedStorageKey(reservation.storageKey) ||
      !new RegExp(
        `^${reservation.cycleId}/[0-9A-Fa-f-]{36}\\.webp$`
      ).test(reservation.storageKey)
    ) {
      throw new SubmissionUploadSagaError("INVALID_MEDIA_KEY", 503);
    }

    const bucket = process.env.R2_BUCKET_NAME;
    if (!bucket) {
      throw new SubmissionUploadSagaError("R2_NOT_CONFIGURED", 503);
    }

    if (!reservation.r2Uploaded) {
      r2WriteAttempted = true;
      let putResult;

      try {
        putResult = await r2.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: reservation.storageKey,
            Body: webpBuffer,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable",
            Metadata: {
              "content-sha256": contentSha256,
            },
          })
        );
      } catch (error) {
        const errorCode = providerErrorCode(error);
        console.error("[submission upload][r2 put]", {
          errorCode,
        });
        await compensateOnce(errorCode);
        throw new SubmissionUploadSagaError("R2_PROVIDER_ERROR", 503);
      }

      await markSubmissionUploadR2Uploaded({
        operationId,
        sessionId,
        etag: putResult.ETag ?? null,
      });
    }

    const completed = await commitSubmissionUpload({
      operationId,
      sessionId,
      mediaWidth: processedImage.width,
      mediaHeight: processedImage.height,
    });

    return uploadJson({
      success: true,
      alreadyCompleted: completed.outcome === "already_completed",
      submissionId: completed.submissionId,
      used: completed.used,
      limit: completed.limit,
      remaining: completed.remaining,
      cooldownRemainingSeconds: completed.cooldownRemainingSeconds,
      nextUploadAllowedAt: completed.nextUploadAllowedAt,
    });
  } catch (error) {
    await compensateOnce(
      error instanceof SubmissionUploadSagaError
        ? error.code
        : "UPLOAD_DEPENDENCY_FAILURE"
    );

    const authStatus = getAuthErrorStatus(error);
    if (authStatus) {
      const fullAuthCode = getAuthErrorCode(error) ?? "";
      const [authCode, ...authCodeDetails] = fullAuthCode.split(":");
      const joinedAt =
        authCode === "JOINED_TOO_RECENTLY" && authCodeDetails.length > 0
          ? authCodeDetails.join(":")
          : null;
      return uploadJson(
        joinedAt
          ? { error: authCode, joinedAt }
          : { error: authCode || "AUTHENTICATION_UNAVAILABLE" },
        { status: authStatus }
      );
    }

    if (error instanceof SubmissionUploadRequestError) {
      return failUpload({
        discordUserId,
        cycleId,
        reason: "validation_failed",
        error: error.code,
        status: error.status,
      });
    }

    if (
      error instanceof MediaValidationError &&
      sessionId &&
      cycleId &&
      isCountableSubmissionMediaErrorCode(error.code)
    ) {
      try {
        const abuseResult = await registerInvalidSubmissionUpload({
          sessionId,
          cycleId,
          errorCode: error.code,
        });

        if (abuseResult.blocked) {
          return failUpload({
            discordUserId,
            cycleId,
            reason: "upload_blocked_for_cycle",
            error: "UPLOAD_BLOCKED_FOR_CYCLE",
            status: 403,
          });
        }
      } catch (counterError) {
        console.error("[submission upload][abuse counter]", {
          errorName:
            counterError instanceof Error
              ? counterError.name
              : "UnknownError",
        });
        return failUpload({
          discordUserId,
          cycleId,
          reason: "dependency_unavailable",
          error: "UPLOAD_DEPENDENCY_UNAVAILABLE",
          status: 503,
        });
      }

      return failUpload({
        discordUserId,
        cycleId,
        reason: error.code.toLowerCase(),
        error: error.code,
        status: error.status,
      });
    }

    if (error instanceof MediaValidationError) {
      return failUpload({
        discordUserId,
        cycleId,
        reason: error.code.toLowerCase(),
        error: error.code,
        status: error.status,
      });
    }

    if (error instanceof SubmissionUploadSagaError) {
      if (error.code === "UPLOAD_COOLDOWN_ACTIVE") {
        return cooldownResponse(error.details);
      }

      return failUpload({
        discordUserId,
        cycleId,
        reason: error.code.toLowerCase(),
        error: error.code,
        status: error.status,
      });
    }

    if (error instanceof UploadEligibilityDependencyError) {
      return failUpload({
        discordUserId,
        cycleId,
        reason: "dependency_unavailable",
        error: "UPLOAD_DEPENDENCY_UNAVAILABLE",
        status: 503,
      });
    }

    console.error("[submission upload][unexpected]", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });

    return failUpload({
      discordUserId,
      cycleId,
      reason: "internal_error",
      error: "UPLOAD_FAILED",
      status: 500,
    });
  }
}
