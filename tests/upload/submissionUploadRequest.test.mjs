import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubmissionContentHash,
  createSubmissionUploadFingerprint,
  normalizeSubmissionPrivateData,
  parseSubmissionUploadIdempotencyKey,
  SubmissionUploadRequestError,
} from "../../lib/upload/submissionUploadRequest.ts";

const WALLET_A = "So11111111111111111111111111111111111111112";
const WALLET_B = "Vote111111111111111111111111111111111111111";

function formData(values) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      data.set(key, String(value));
    }
  }
  return data;
}

test("accepts only random UUID v4 idempotency keys", () => {
  const key = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(parseSubmissionUploadIdempotencyKey(key.toUpperCase()), key);

  for (const invalid of [
    null,
    "",
    "personal-data@example.com",
    "550e8400-e29b-11d4-a716-446655440000",
    "550e8400-e29b-41d4-7716-446655440000",
  ]) {
    assert.throws(
      () => parseSubmissionUploadIdempotencyKey(invalid),
      SubmissionUploadRequestError
    );
  }
});

test("normalizes keep, donate, and split private data canonically", () => {
  assert.deepEqual(
    normalizeSubmissionPrivateData(
      formData({
        walletAddress: ` ${WALLET_A} `,
        walletSource: "manual",
        payoutChoice: "keep",
        splitPercent: 50,
      })
    ),
    {
      walletSource: "manual",
      manualWalletAddress: WALLET_A,
      profileWalletVersion: null,
      payoutChoice: "keep",
      splitPercent: null,
      charity: null,
    }
  );

  assert.deepEqual(
    normalizeSubmissionPrivateData(
      formData({
        walletAddress: "",
        walletSource: "none",
        payoutChoice: "donate",
        charity: " Charity ",
      })
    ),
    {
      walletSource: "none",
      manualWalletAddress: null,
      profileWalletVersion: null,
      payoutChoice: "donate",
      splitPercent: null,
      charity: "Charity",
    }
  );

  assert.deepEqual(
    normalizeSubmissionPrivateData(
      formData({
        walletAddress: WALLET_B,
        walletSource: "manual",
        payoutChoice: "split",
        splitPercent: 25,
        charity: "Charity",
      })
    ),
    {
      walletSource: "manual",
      manualWalletAddress: WALLET_B,
      profileWalletVersion: null,
      payoutChoice: "split",
      splitPercent: 25,
      charity: "Charity",
    }
  );
});

test("invalid private combinations fail before R2 or database writes", () => {
  for (const values of [
    { payoutChoice: "keep", walletSource: "manual", walletAddress: "" },
    { payoutChoice: "donate", walletSource: "none", charity: "" },
    {
      payoutChoice: "split",
      walletSource: "manual",
      walletAddress: WALLET_A,
      charity: "Charity",
      splitPercent: 100,
    },
    { payoutChoice: "unknown", walletSource: "manual", walletAddress: WALLET_A },
    {
      payoutChoice: "keep",
      walletSource: "profile",
      profileWalletVersion: 4,
      walletAddress: WALLET_B,
    },
  ]) {
    assert.throws(
      () => normalizeSubmissionPrivateData(formData(values)),
      SubmissionUploadRequestError
    );
  }
});

test("fingerprints are stable for identical canonical data and conflict on changes", () => {
  const contentSha256 = createSubmissionContentHash(
    Buffer.from("synthetic transformed image")
  );
  const privateData = {
    walletSource: "profile",
    manualWalletAddress: null,
    profileWalletVersion: 4,
    payoutChoice: "split",
    splitPercent: 50,
    charity: "Charity",
  };
  const first = createSubmissionUploadFingerprint({
    contentSha256,
    privateData,
  });
  const replay = createSubmissionUploadFingerprint({
    contentSha256,
    privateData: { ...privateData },
  });
  const changed = createSubmissionUploadFingerprint({
    contentSha256,
    privateData: { ...privateData, splitPercent: 49 },
  });

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(replay, first);
  assert.notEqual(changed, first);
});
