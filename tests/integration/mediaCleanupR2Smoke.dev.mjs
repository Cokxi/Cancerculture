import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

register(new URL("./nextAliasLoader.mjs", import.meta.url));

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const requiredBucket = "cancerculture-local";
const testPrefix = "tests/media-cleanup-smoke";
const runId = randomUUID();
const reason = `dev_r2_smoke:${runId}`;
const objectKey = `${testPrefix}/${Date.now()}-${runId}-present.txt`;
const missingKey = `${testPrefix}/${Date.now()}-${randomUUID()}-missing.txt`;
const testKeys = [objectKey, missingKey];
const createdQueueIds = [];
let safetyValidated = false;
let r2Client;
let supabaseAdmin;
let baselineRows = [];
let cleanupIssues = [];

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

function sanitizedErrorClass(error) {
  const candidate =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "UnknownError";
  return (candidate.replace(/[^A-Za-z0-9_.-]/g, "_") || "UnknownError").slice(
    0,
    80
  );
}

function shortKey(key) {
  const randomPart = key.split("/").at(-1) ?? "unknown";
  return randomPart.slice(-20);
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
  const requiredWebsiteKeys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
  ];

  for (const key of requiredWebsiteKeys) {
    const fileValue = websiteEnv.get(key);

    if (!fileValue) {
      throw new Error(`SAFE_PRECONDITION_MISSING_${key}`);
    }

    if (process.env[key] && process.env[key] !== fileValue) {
      throw new Error(`SAFE_PRECONDITION_AMBIGUOUS_${key}`);
    }

    process.env[key] = fileValue;
  }

  if (process.env.R2_BUCKET_NAME !== requiredBucket) {
    throw new Error("SAFE_PRECONDITION_DEV_BUCKET_MISMATCH");
  }

  const databaseUrlValue = databaseEnv.get("SUPABASE_DEV_DATABASE_URL");
  if (!databaseUrlValue) {
    throw new Error("SAFE_PRECONDITION_DEV_DATABASE_URL_MISSING");
  }

  const websiteUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const databaseUrl = new URL(databaseUrlValue);
  const projectReference = websiteUrl.hostname.split(".")[0];

  if (
    websiteUrl.protocol !== "https:" ||
    !websiteUrl.hostname.endsWith(".supabase.co") ||
    databaseUrl.protocol !== "postgresql:" ||
    !databaseUrl.hostname.endsWith(".supabase.com") ||
    !projectReference ||
    !databaseUrlValue.includes(projectReference)
  ) {
    throw new Error("SAFE_PRECONDITION_DEV_SUPABASE_MISMATCH");
  }

  const serviceRolePayload = decodeJwtPayload(
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (
    serviceRolePayload &&
    (serviceRolePayload.role !== "service_role" ||
      (serviceRolePayload.ref && serviceRolePayload.ref !== projectReference))
  ) {
    throw new Error("SAFE_PRECONDITION_SERVICE_ROLE_MISMATCH");
  }

  safetyValidated = true;
}

function assertSafeBeforeExternalOperation() {
  if (!safetyValidated || process.env.R2_BUCKET_NAME !== requiredBucket) {
    throw new Error("SAFE_PRECONDITION_NOT_VALIDATED");
  }
}

async function objectExists(key) {
  assertSafeBeforeExternalOperation();

  try {
    await r2Client.send(
      new HeadObjectCommand({
        Bucket: requiredBucket,
        Key: key,
      })
    );
    return true;
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (error?.name === "NotFound" || error?.name === "NoSuchKey" || statusCode === 404) {
      return false;
    }

    throw Object.assign(new Error("HEAD_OBJECT_FAILED"), {
      name: sanitizedErrorClass(error),
    });
  }
}

async function loadQueueRows() {
  assertSafeBeforeExternalOperation();
  const { data, error } = await supabaseAdmin
    .from("media_cleanup_queue")
    .select(
      "id, storage_provider, storage_key, reason, status, attempts, last_error_code, created_at, processed_at, next_attempt_at, locked_at, locked_until, lease_token, last_attempt_at, updated_at"
    )
    .order("id", { ascending: true });

  if (error) {
    throw Object.assign(new Error("QUEUE_READ_FAILED"), {
      name: error.code || "QueueReadError",
    });
  }

  return data ?? [];
}

async function insertQueueJob(key) {
  assertSafeBeforeExternalOperation();
  const { data, error } = await supabaseAdmin
    .from("media_cleanup_queue")
    .insert({
      storage_provider: "r2",
      storage_key: key,
      reason,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data || typeof data.id !== "number") {
    throw Object.assign(new Error("QUEUE_INSERT_FAILED"), {
      name: error?.code || "QueueInsertError",
    });
  }

  createdQueueIds.push(data.id);
  return data.id;
}

async function getQueueJob(id) {
  assertSafeBeforeExternalOperation();
  const { data, error } = await supabaseAdmin
    .from("media_cleanup_queue")
    .select(
      "id, status, attempts, next_attempt_at, locked_at, locked_until, lease_token, processed_at, last_error_code"
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    throw Object.assign(new Error("QUEUE_JOB_READ_FAILED"), {
      name: error?.code || "QueueJobReadError",
    });
  }

  return data;
}

async function deleteTestObjects() {
  if (!safetyValidated || !r2Client) {
    return;
  }

  for (const key of testKeys) {
    try {
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: requiredBucket,
          Key: key,
        })
      );
    } catch (error) {
      cleanupIssues.push({
        artifact: shortKey(key),
        operation: "DeleteObject",
        errorClass: sanitizedErrorClass(error),
      });
    }
  }
}

async function deleteQueueFixtures() {
  if (!safetyValidated || !supabaseAdmin) {
    return;
  }

  try {
    let query = supabaseAdmin
      .from("media_cleanup_queue")
      .delete()
      .eq("reason", reason)
      .in("storage_key", testKeys);

    if (createdQueueIds.length > 0) {
      query = query.in("id", createdQueueIds);
    }

    const { error } = await query;
    if (error) {
      throw Object.assign(new Error("QUEUE_FIXTURE_DELETE_FAILED"), {
        name: error.code || "QueueFixtureDeleteError",
      });
    }
  } catch (error) {
    cleanupIssues.push({
      artifact: testKeys.map(shortKey).join(","),
      operation: "QueueCleanup",
      errorClass: sanitizedErrorClass(error),
    });
  }
}

async function verifyCleanupAndHistory() {
  if (!safetyValidated || !supabaseAdmin) {
    return;
  }

  try {
    const currentRows = await loadQueueRows();
    assert.deepEqual(currentRows, baselineRows);

    for (const key of testKeys) {
      assert.equal(await objectExists(key), false);
    }
  } catch (error) {
    cleanupIssues.push({
      artifact: testKeys.map(shortKey).join(","),
      operation: "CleanupVerification",
      errorClass: sanitizedErrorClass(error),
    });
  }
}

let failure = null;

try {
  await loadAndValidateEnvironment();

  const [{ supabaseAdmin: admin }, { r2 }, state, worker] = await Promise.all([
    import("../../lib/db/admin.ts"),
    import("../../lib/r2.ts"),
    import("../../lib/r2/mediaCleanupState.ts"),
    import("../../lib/r2/processMediaCleanupQueue.ts"),
  ]);
  supabaseAdmin = admin;
  r2Client = r2;

  assert.equal(state.isCanonicalQueuedStorageKey(objectKey), true);
  assert.equal(state.isCanonicalQueuedStorageKey(missingKey), true);

  baselineRows = await loadQueueRows();
  if (baselineRows.some((row) => row.status !== "completed")) {
    throw new Error("SAFE_PRECONDITION_HISTORICAL_QUEUE_NOT_QUIESCENT");
  }

  assert.equal(await objectExists(objectKey), false);
  assert.equal(await objectExists(missingKey), false);

  assertSafeBeforeExternalOperation();
  await r2Client.send(
    new PutObjectCommand({
      Bucket: requiredBucket,
      Key: objectKey,
      Body: "CancerCulture DEV media cleanup smoke test",
      ContentType: "text/plain",
    })
  );
  assert.equal(await objectExists(objectKey), true);

  const presentJobId = await insertQueueJob(objectKey);
  assertSafeBeforeExternalOperation();
  const presentResult = await worker.processR2CleanupQueue();

  assert.deepEqual(presentResult, {
    claimed: 1,
    completed: 1,
    deleted: 1,
    alreadyMissing: 0,
    retryScheduled: 0,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 0,
  });

  const presentJob = await getQueueJob(presentJobId);
  assert.equal(presentJob.status, "completed");
  assert.equal(presentJob.attempts, 1);
  assert.equal(presentJob.processed_at !== null, true);
  assert.equal(presentJob.next_attempt_at, null);
  assert.equal(presentJob.locked_at, null);
  assert.equal(presentJob.locked_until, null);
  assert.equal(presentJob.lease_token, null);
  assert.equal(presentJob.last_error_code, null);
  assert.equal(await objectExists(objectKey), false);

  const missingJobId = await insertQueueJob(missingKey);
  assertSafeBeforeExternalOperation();
  const missingResult = await worker.processR2CleanupQueue();

  assert.deepEqual(missingResult, {
    claimed: 1,
    completed: 1,
    deleted: 0,
    alreadyMissing: 1,
    retryScheduled: 0,
    terminalFailures: 0,
    staleResults: 0,
    confirmationFailures: 0,
    deletionFailures: 0,
  });

  const missingJob = await getQueueJob(missingJobId);
  assert.equal(missingJob.status, "completed");
  assert.equal(missingJob.attempts, 1);
  assert.equal(missingJob.processed_at !== null, true);
  assert.equal(missingJob.next_attempt_at, null);
  assert.equal(missingJob.locked_at, null);
  assert.equal(missingJob.locked_until, null);
  assert.equal(missingJob.lease_token, null);
  assert.equal(missingJob.last_error_code, null);
  assert.equal(await objectExists(missingKey), false);

  console.log("DEV R2 media cleanup smoke assertions passed.");
} catch (error) {
  failure = {
    operation:
      error instanceof Error && error.message.startsWith("SAFE_PRECONDITION_")
        ? "SafetyPrecondition"
        : error instanceof Error
          ? error.message.slice(0, 80)
          : "SmokeTest",
    errorClass: sanitizedErrorClass(error),
  };
} finally {
  await deleteTestObjects();
  await deleteQueueFixtures();
  await verifyCleanupAndHistory();
}

if (cleanupIssues.length > 0) {
  console.error("DEV R2 smoke cleanup incomplete", cleanupIssues);
  process.exitCode = 1;
} else if (failure) {
  console.error("DEV R2 smoke failed", failure);
  process.exitCode = 1;
} else {
  console.log("DEV R2 smoke cleanup and historical queue verification passed.");
}
