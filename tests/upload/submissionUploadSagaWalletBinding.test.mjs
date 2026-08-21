import assert from "node:assert/strict";
import { mock, test } from "node:test";

const state = { calls: [], data: null, error: null };

mock.module(new URL("../../lib/db/admin.ts", import.meta.url), {
  namedExports: {
    supabaseAdmin: {
      rpc(name, parameters) {
        state.calls.push({ name, parameters });
        return Promise.resolve({ data: state.data, error: state.error });
      },
    },
  },
});

mock.module(
  new URL("../../lib/r2/processMediaCleanupQueue.ts", import.meta.url),
  { namedExports: { processR2CleanupQueue: async () => undefined } }
);

const {
  commitSubmissionUpload,
  getCompletedSubmissionUploadOperation,
  reserveSubmissionUpload,
  bindSubmissionUploadOrganization,
} = await import("../../lib/upload/submissionUploadSaga.ts");

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const idempotencyKey = "223e4567-e89b-42d3-a456-426614174000";
const profilePrivateData = {
  walletSource: "profile",
  manualWalletAddress: null,
  profileWalletVersion: 7,
  payoutChoice: "keep",
  splitPercent: null,
  charity: null,
  organizationSelection: null,
};

test.beforeEach(() => {
  state.calls = [];
  state.data = null;
  state.error = null;
});

test("catalog binding sends only the stable public key and reservation fingerprint", async () => {
  state.data = { outcome: "bound", replayed: false };
  await bindSubmissionUploadOrganization({
    operationId: "423e4567-e89b-42d3-a456-426614174000",
    sessionId,
    requestFingerprint: "a".repeat(64),
    privateData: {
      walletSource: "none",
      manualWalletAddress: null,
      profileWalletVersion: null,
      payoutChoice: "donate",
      splitPercent: null,
      charity: "Animal Haven",
      organizationSelection: {
        sourceType: "catalog",
        publicKey: "animal-haven",
        otherName: null,
        otherWebsiteUrl: null,
      },
    },
  });
  assert.deepEqual(state.calls[0], {
    name: "bind_submission_upload_organization",
    parameters: {
      p_operation_id: "423e4567-e89b-42d3-a456-426614174000",
      p_session_id: sessionId,
      p_request_fingerprint: "a".repeat(64),
      p_source_type: "catalog",
      p_public_key: "animal-haven",
      p_other_name: null,
      p_other_website_url: null,
    },
  });
});

test("completed replay lookup is session-scoped and returns no private data", async () => {
  state.data = {
    outcome: "completed",
    operationId: "323e4567-e89b-42d3-a456-426614174000",
    cycleId: 4,
    submissionId: 9,
    walletAddress: "must-not-project",
  };
  assert.deepEqual(
    await getCompletedSubmissionUploadOperation({ sessionId, idempotencyKey }),
    {
      operationId: "323e4567-e89b-42d3-a456-426614174000",
      cycleId: 4,
      submissionId: 9,
    }
  );
  assert.deepEqual(state.calls, [
    {
      name: "get_completed_submission_upload_operation",
      parameters: {
        p_idempotency_key: idempotencyKey,
        p_session_id: sessionId,
      },
    },
  ]);
});

test("reserve sends only source and displayed version for a Profile Wallet", async () => {
  state.data = {
    outcome: "reserved",
    operationId: "423e4567-e89b-42d3-a456-426614174000",
    cycleId: 4,
    storageKey: "4/523e4567-e89b-42d3-a456-426614174000.webp",
    r2Uploaded: false,
  };
  const result = await reserveSubmissionUpload({
    sessionId,
    idempotencyKey,
    requestFingerprint: "a".repeat(64),
    contentSha256: "b".repeat(64),
    mediaBytes: 100,
    privateData: profilePrivateData,
  });
  assert.equal(result.r2Uploaded, false);
  assert.deepEqual(state.calls[0].parameters, {
    p_content_sha256: "b".repeat(64),
    p_idempotency_key: idempotencyKey,
    p_media_bytes: 100,
    p_media_type: "image/webp",
    p_manual_wallet_address: null,
    p_payout_choice: "keep",
    p_profile_wallet_version: 7,
    p_request_fingerprint: "a".repeat(64),
    p_session_id: sessionId,
    p_split_percent: null,
    p_charity: null,
    p_wallet_source: "profile",
  });
});

test("stale Profile Wallet outcome remains a distinct retryable conflict", async () => {
  state.data = { outcome: "profile_wallet_stale" };
  await assert.rejects(
    reserveSubmissionUpload({
      sessionId,
      idempotencyKey,
      requestFingerprint: "a".repeat(64),
      contentSha256: "b".repeat(64),
      mediaBytes: 100,
      privateData: profilePrivateData,
    }),
    (error) => error.status === 409 && error.code === "PROFILE_WALLET_STALE"
  );
});

test("commit RPC accepts dimensions but no wallet or payout data", async () => {
  state.data = {
    outcome: "completed",
    operationId: "423e4567-e89b-42d3-a456-426614174000",
    cycleId: 4,
    submissionId: 9,
  };
  await commitSubmissionUpload({
    operationId: "423e4567-e89b-42d3-a456-426614174000",
    sessionId,
    mediaWidth: 1200,
    mediaHeight: 800,
  });
  assert.deepEqual(state.calls[0], {
    name: "commit_submission_upload",
    parameters: {
      p_media_height: 800,
      p_media_width: 1200,
      p_operation_id: "423e4567-e89b-42d3-a456-426614174000",
      p_session_id: sessionId,
    },
  });
});
