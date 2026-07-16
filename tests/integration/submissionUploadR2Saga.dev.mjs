import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

register(new URL("./nextAliasLoader.mjs", import.meta.url));

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const requiredBucket = "cancerculture-local";
const runId = randomUUID();
let cycleId = null;
const userPrefix = `codex-upload-r2-${runId}`;
const users = {
  success: `${userPrefix}-success`,
  compensated: `${userPrefix}-compensated`,
  putFailure: `${userPrefix}-put-failure`,
};
const sessions = {
  success: randomUUID(),
  compensated: randomUUID(),
  putFailure: randomUUID(),
};
const idempotencyKeys = {
  success: randomUUID(),
  compensated: randomUUID(),
  putFailure: randomUUID(),
};
const createdKeys = [];
let safetyValidated = false;
let supabaseAdmin;
let r2Client;
let processR2CleanupQueue;
let reserveSubmissionUpload;
let markSubmissionUploadR2Uploaded;
let commitSubmissionUpload;
let compensateSubmissionUpload;
let registerInvalidSubmissionUpload;
let createSubmissionUploadFingerprint;
let processStaticImage;
let submissionMediaProfile;
let baselineQueue = [];

function parseDotenv(contents) {
  const values = new Map();

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return values;
}

function decodeJwtPayload(value) {
  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function loadAndValidateEnvironment() {
  const [websiteContents, databaseContents] = await Promise.all([
    readFile(path.join(repoRoot, ".env.local"), "utf8"),
    readFile(path.join(repoRoot, ".env.codex.local"), "utf8"),
  ]);
  const websiteEnv = parseDotenv(websiteContents);
  const databaseEnv = parseDotenv(databaseContents);
  const requiredKeys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
  ];

  for (const key of requiredKeys) {
    const value = websiteEnv.get(key);
    if (!value || (process.env[key] && process.env[key] !== value)) {
      throw new Error(`SAFE_PRECONDITION_${key}`);
    }
    process.env[key] = value;
  }

  if (process.env.R2_BUCKET_NAME !== requiredBucket) {
    throw new Error("SAFE_PRECONDITION_DEV_BUCKET_MISMATCH");
  }

  const databaseUrl = databaseEnv.get("SUPABASE_DEV_DATABASE_URL");
  if (!databaseUrl) {
    throw new Error("SAFE_PRECONDITION_DEV_DATABASE_MISSING");
  }

  const websiteUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const parsedDatabaseUrl = new URL(databaseUrl);
  const websiteRef = websiteUrl.hostname.split(".")[0];
  const databaseRef =
    parsedDatabaseUrl.hostname.match(/^db\.([^.]+)\./u)?.[1] ??
    decodeURIComponent(parsedDatabaseUrl.username).match(
      /^postgres\.([^:]+)$/u
    )?.[1];

  if (
    websiteUrl.protocol !== "https:" ||
    !websiteUrl.hostname.endsWith(".supabase.co") ||
    parsedDatabaseUrl.protocol !== "postgresql:" ||
    !websiteRef ||
    databaseRef !== websiteRef
  ) {
    throw new Error("SAFE_PRECONDITION_DEV_PROJECT_MISMATCH");
  }

  const serviceRolePayload = decodeJwtPayload(
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (
    serviceRolePayload &&
    (serviceRolePayload.role !== "service_role" ||
      (serviceRolePayload.ref && serviceRolePayload.ref !== websiteRef))
  ) {
    throw new Error("SAFE_PRECONDITION_SERVICE_ROLE_MISMATCH");
  }

  safetyValidated = true;
}

function assertSafeExternalOperation() {
  if (!safetyValidated || process.env.R2_BUCKET_NAME !== requiredBucket) {
    throw new Error("SAFE_PRECONDITION_NOT_VALIDATED");
  }
}

async function objectExists(key) {
  assertSafeExternalOperation();
  try {
    await r2Client.send(
      new HeadObjectCommand({ Bucket: requiredBucket, Key: key })
    );
    return true;
  } catch (error) {
    if (
      error?.name === "NotFound" ||
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return false;
    }
    throw error;
  }
}

async function checkedDelete(key) {
  assertSafeExternalOperation();
  await r2Client.send(
    new DeleteObjectCommand({ Bucket: requiredBucket, Key: key })
  );
}

async function checkedPut(key, body, contentSha256) {
  assertSafeExternalOperation();
  return r2Client.send(
    new PutObjectCommand({
      Bucket: requiredBucket,
      Key: key,
      Body: body,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
      Metadata: { "content-sha256": contentSha256 },
    })
  );
}

async function assertNoError(operation, label) {
  const result = await operation;
  if (result.error) {
    const code = String(result.error.code ?? "UNKNOWN").replace(
      /[^A-Za-z0-9_.-]/gu,
      "_"
    );
    throw new Error(`DATABASE_${label}_${code.slice(0, 40)}`);
  }
  return result.data;
}

async function cleanupDatabaseFixtures() {
  const operationRows = await assertNoError(
    supabaseAdmin
      .from("submission_upload_operations")
      .select("storage_key")
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_OPERATION_KEYS"
  );
  for (const row of operationRows ?? []) {
    if (!createdKeys.includes(row.storage_key)) {
      createdKeys.push(row.storage_key);
    }
  }

  await assertNoError(
    supabaseAdmin
      .from("upload_logs")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_UPLOAD_LOGS"
  );
  await assertNoError(
    supabaseAdmin
      .from("submissions")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_SUBMISSIONS"
  );
  await assertNoError(
    supabaseAdmin
      .from("submission_upload_operations")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_OPERATIONS"
  );
  await assertNoError(
    supabaseAdmin
      .from("submission_upload_abuse_states")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_ABUSE_STATES"
  );
  if (createdKeys.length > 0) {
    await assertNoError(
      supabaseAdmin
        .from("media_cleanup_queue")
        .delete()
        .in("storage_key", createdKeys),
      "CLEANUP_QUEUE"
    );
  }
  await assertNoError(
    supabaseAdmin
      .from("sessions")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_SESSIONS"
  );
  await assertNoError(
    supabaseAdmin
      .from("user_social_links")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_SOCIALS"
  );
  await assertNoError(
    supabaseAdmin
      .from("discord_member_state")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_MEMBERSHIP"
  );
  await assertNoError(
    supabaseAdmin
      .from("user_logs")
      .delete()
      .in("discord_user_id", Object.values(users)),
    "CLEANUP_USERS"
  );
}

async function setupDatabaseFixtures() {
  const currentCycles = await assertNoError(
    supabaseAdmin
      .from("voting_cycles")
      .select("id, status")
      .in("status", ["active", "submission_open"]),
    "CURRENT_CYCLE_GUARD"
  );
  assert.equal(currentCycles?.length ?? 0, 1);
  cycleId = currentCycles[0].id;

  const rules = await assertNoError(
    supabaseAdmin
      .from("rules_meta")
      .select("current_version")
      .eq("id", 1)
      .single(),
    "RULES"
  );

  await assertNoError(
    supabaseAdmin.from("user_logs").insert([
      {
        discord_user_id: users.success,
        current_discord_username: "codex-r2-success",
        accepted_rules_version: rules.current_version,
        show_socials_on_submissions: true,
      },
      {
        discord_user_id: users.compensated,
        current_discord_username: "codex-r2-compensated",
        accepted_rules_version: rules.current_version,
        show_socials_on_submissions: false,
      },
      {
        discord_user_id: users.putFailure,
        current_discord_username: "codex-r2-put-failure",
        accepted_rules_version: rules.current_version,
        show_socials_on_submissions: false,
      },
    ]),
    "USER_INSERT"
  );
  await assertNoError(
    supabaseAdmin.from("discord_member_state").insert([
      {
        discord_user_id: users.success,
        current_discord_username: "codex-r2-success",
        discord_joined_at: new Date(Date.now() - 86_400_000).toISOString(),
        is_in_discord: true,
      },
      {
        discord_user_id: users.compensated,
        current_discord_username: "codex-r2-compensated",
        discord_joined_at: new Date(Date.now() - 86_400_000).toISOString(),
        is_in_discord: true,
      },
      {
        discord_user_id: users.putFailure,
        current_discord_username: "codex-r2-put-failure",
        discord_joined_at: new Date(Date.now() - 86_400_000).toISOString(),
        is_in_discord: true,
      },
    ]),
    "MEMBERSHIP_INSERT"
  );
  await assertNoError(
    supabaseAdmin.from("sessions").insert([
      { id: sessions.success, discord_user_id: users.success },
      { id: sessions.compensated, discord_user_id: users.compensated },
      { id: sessions.putFailure, discord_user_id: users.putFailure },
    ]),
    "SESSION_INSERT"
  );
  await assertNoError(
    supabaseAdmin.from("user_social_links").insert({
      discord_user_id: users.success,
      platform: "x",
      handle: "@codex_r2_test",
      profile_url: "https://x.com/codex_r2_test",
      is_verified: true,
      verified_at: new Date().toISOString(),
    }),
    "SOCIAL_INSERT"
  );
}

async function createMedia() {
  const input = await sharp({
    create: {
      width: 20,
      height: 10,
      channels: 3,
      background: { r: 255, g: 128, b: 0 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  const processed = await processStaticImage({
    input,
    claimedMimeType: "image/jpeg",
    profile: submissionMediaProfile,
  });
  const body = processed.buffer;
  return {
    body,
    contentSha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function reserve({ userType, media, privateData }) {
  const requestFingerprint = createSubmissionUploadFingerprint({
    contentSha256: media.contentSha256,
    privateData,
  });
  const result = await reserveSubmissionUpload({
    sessionId: sessions[userType],
    idempotencyKey: idempotencyKeys[userType],
    requestFingerprint,
    contentSha256: media.contentSha256,
    mediaBytes: media.body.byteLength,
  });
  assert.equal(result.outcome, "reserved");
  createdKeys.push(result.storageKey);
  assert.equal(await objectExists(result.storageKey), false);
  return { result, requestFingerprint };
}

async function runSuccessCase(media) {
  const privateData = {
    walletAddress: "synthetic-wallet",
    payoutChoice: "split",
    splitPercent: 50,
    charity: "Synthetic Charity",
  };
  const { result: reservation, requestFingerprint } = await reserve({
    userType: "success",
    media,
    privateData,
  });
  const putResult = await checkedPut(
    reservation.storageKey,
    media.body,
    media.contentSha256
  );
  assert.equal(await objectExists(reservation.storageKey), true);
  await markSubmissionUploadR2Uploaded({
    operationId: reservation.operationId,
    sessionId: sessions.success,
    etag: putResult.ETag ?? null,
  });
  const completed = await commitSubmissionUpload({
    operationId: reservation.operationId,
    sessionId: sessions.success,
    privateData,
  });
  assert.equal(completed.outcome, "completed");

  const [submissionRows, privateRows, socialRows] = await Promise.all([
    assertNoError(
      supabaseAdmin
        .from("submissions")
        .select("id, r2_key")
        .eq("id", completed.submissionId),
      "SUCCESS_SUBMISSION"
    ),
    assertNoError(
      supabaseAdmin
        .from("submission_private_data")
        .select("submission_id")
        .eq("submission_id", completed.submissionId),
      "SUCCESS_PRIVATE"
    ),
    assertNoError(
      supabaseAdmin
        .from("submission_social_links")
        .select("submission_id")
        .eq("submission_id", completed.submissionId),
      "SUCCESS_SOCIAL"
    ),
  ]);
  assert.equal(submissionRows.length, 1);
  assert.equal(privateRows.length, 1);
  assert.equal(socialRows.length, 1);

  const replay = await reserveSubmissionUpload({
    sessionId: sessions.success,
    idempotencyKey: idempotencyKeys.success,
    requestFingerprint,
    contentSha256: media.contentSha256,
    mediaBytes: media.body.byteLength,
  });
  assert.equal(replay.outcome, "already_completed");
  assert.equal(replay.submissionId, completed.submissionId);

  await assertNoError(
    supabaseAdmin
      .from("submissions")
      .delete()
      .eq("id", completed.submissionId),
    "SUCCESS_DELETE"
  );
  const cleanup = await processR2CleanupQueue();
  assert.equal(cleanup.completed >= 1, true);
  assert.equal(await objectExists(reservation.storageKey), false);
}

async function runCompensationCase(media) {
  const privateData = {
    walletAddress: "synthetic-wallet-2",
    payoutChoice: "keep",
    splitPercent: null,
    charity: null,
  };
  const { result: reservation } = await reserve({
    userType: "compensated",
    media,
    privateData,
  });
  const putResult = await checkedPut(
    reservation.storageKey,
    media.body,
    media.contentSha256
  );
  assert.equal(await objectExists(reservation.storageKey), true);
  await markSubmissionUploadR2Uploaded({
    operationId: reservation.operationId,
    sessionId: sessions.compensated,
    etag: putResult.ETag ?? null,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const abuse = await registerInvalidSubmissionUpload({
      sessionId: sessions.compensated,
      cycleId,
      errorCode: "MEDIA_CORRUPT",
    });
    assert.equal(abuse.blocked, attempt === 4);
  }

  let commitError;
  try {
    await commitSubmissionUpload({
      operationId: reservation.operationId,
      sessionId: sessions.compensated,
      privateData,
    });
  } catch (error) {
    commitError = error;
  }
  assert.equal(commitError?.code, "UPLOAD_BLOCKED_FOR_CYCLE");

  const compensation = await compensateSubmissionUpload({
    operationId: reservation.operationId,
    sessionId: sessions.compensated,
    errorCode: commitError.code,
  });
  assert.equal(compensation.cleanupDurable, true);
  if (await objectExists(reservation.storageKey)) {
    await processR2CleanupQueue();
  }
  assert.equal(await objectExists(reservation.storageKey), false);

  const [submissionRows, operationRows, queueRows] = await Promise.all([
    assertNoError(
      supabaseAdmin
        .from("submissions")
        .select("id")
        .eq("discord_user_id", users.compensated),
      "COMPENSATED_SUBMISSION"
    ),
    assertNoError(
      supabaseAdmin
        .from("submission_upload_operations")
        .select("status, cleanup_required")
        .eq("id", reservation.operationId),
      "COMPENSATED_OPERATION"
    ),
    assertNoError(
      supabaseAdmin
        .from("media_cleanup_queue")
        .select("status")
        .eq("storage_key", reservation.storageKey),
      "COMPENSATED_QUEUE"
    ),
  ]);
  assert.equal(submissionRows.length, 0);
  assert.deepEqual(operationRows, [
    { status: "cleanup_pending", cleanup_required: true },
  ]);
  assert.deepEqual(queueRows, [{ status: "completed" }]);
}

async function runPutFailureCase(media) {
  const privateData = {
    walletAddress: "synthetic-wallet-3",
    payoutChoice: "keep",
    splitPercent: null,
    charity: null,
  };
  const { result: reservation } = await reserve({
    userType: "putFailure",
    media,
    privateData,
  });

  let putError;
  try {
    const simulatedPutObject = async () => {
      const error = new Error("sanitized simulated provider failure");
      error.name = "ServiceUnavailable";
      throw error;
    };
    await simulatedPutObject();
  } catch (error) {
    putError = error;
  }
  assert.equal(putError?.name, "ServiceUnavailable");

  const compensation = await compensateSubmissionUpload({
    operationId: reservation.operationId,
    sessionId: sessions.putFailure,
    errorCode: putError.name,
  });
  assert.equal(compensation.cleanupDurable, true);
  if (await objectExists(reservation.storageKey)) {
    await processR2CleanupQueue();
  }

  const [submissionRows, queueRows] = await Promise.all([
    assertNoError(
      supabaseAdmin
        .from("submissions")
        .select("id")
        .eq("discord_user_id", users.putFailure),
      "PUT_FAILURE_SUBMISSION"
    ),
    assertNoError(
      supabaseAdmin
        .from("media_cleanup_queue")
        .select("status")
        .eq("storage_key", reservation.storageKey),
      "PUT_FAILURE_QUEUE"
    ),
  ]);
  assert.equal(submissionRows.length, 0);
  assert.deepEqual(queueRows, [{ status: "completed" }]);
  assert.equal(await objectExists(reservation.storageKey), false);
}

await loadAndValidateEnvironment();

const [{ supabaseAdmin: loadedSupabase }, { r2 }, cleanupModule, sagaModule, requestModule, mediaModule, profileModule] =
  await Promise.all([
    import("../../lib/db/admin.ts"),
    import("../../lib/r2.ts"),
    import("../../lib/r2/processMediaCleanupQueue.ts"),
    import("../../lib/upload/submissionUploadSaga.ts"),
    import("../../lib/upload/submissionUploadRequest.ts"),
    import("../../lib/media/processStaticImage.ts"),
    import("../../lib/media/profiles.ts"),
  ]);
supabaseAdmin = loadedSupabase;
r2Client = r2;
processR2CleanupQueue = cleanupModule.processR2CleanupQueue;
reserveSubmissionUpload = sagaModule.reserveSubmissionUpload;
markSubmissionUploadR2Uploaded = sagaModule.markSubmissionUploadR2Uploaded;
commitSubmissionUpload = sagaModule.commitSubmissionUpload;
compensateSubmissionUpload = sagaModule.compensateSubmissionUpload;
registerInvalidSubmissionUpload =
  sagaModule.registerInvalidSubmissionUpload;
createSubmissionUploadFingerprint =
  requestModule.createSubmissionUploadFingerprint;
processStaticImage = mediaModule.processStaticImage;
submissionMediaProfile = profileModule.SUBMISSION_MEDIA_PROFILE;

baselineQueue = await assertNoError(
  supabaseAdmin
    .from("media_cleanup_queue")
    .select(
      "id, storage_provider, storage_key, reason, status, attempts, last_error_code, created_at, processed_at, next_attempt_at, locked_at, locked_until, lease_token, last_attempt_at, updated_at"
    )
    .order("id", { ascending: true }),
  "QUEUE_BASELINE"
);

await cleanupDatabaseFixtures();

try {
  await setupDatabaseFixtures();
  const media = await createMedia();
  await runSuccessCase(media);
  await runCompensationCase(media);
  await runPutFailureCase(media);
  console.log("DEV R2 submission upload saga smoke assertions passed.");
} finally {
  for (const key of createdKeys) {
    try {
      await checkedDelete(key);
    } catch {}
  }
  await cleanupDatabaseFixtures();
}

for (const key of createdKeys) {
  assert.equal(await objectExists(key), false);
}
const queueAfter = await assertNoError(
  supabaseAdmin
    .from("media_cleanup_queue")
    .select(
      "id, storage_provider, storage_key, reason, status, attempts, last_error_code, created_at, processed_at, next_attempt_at, locked_at, locked_until, lease_token, last_attempt_at, updated_at"
    )
    .order("id", { ascending: true }),
  "QUEUE_AFTER"
);
assert.deepEqual(queueAfter, baselineQueue);

console.log("DEV R2 submission upload saga cleanup passed.");
