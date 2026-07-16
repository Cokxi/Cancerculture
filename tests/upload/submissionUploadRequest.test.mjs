import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubmissionContentHash,
  createSubmissionUploadFingerprint,
  normalizeSubmissionPrivateData,
  parseSubmissionUploadIdempotencyKey,
  SubmissionUploadRequestError,
} from "../../lib/upload/submissionUploadRequest.ts";

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
        walletAddress: " wallet-a ",
        payoutChoice: "keep",
        splitPercent: 50,
      })
    ),
    {
      walletAddress: "wallet-a",
      payoutChoice: "keep",
      splitPercent: null,
      charity: null,
    }
  );

  assert.deepEqual(
    normalizeSubmissionPrivateData(
      formData({
        walletAddress: "ignored",
        payoutChoice: "donate",
        charity: " Charity ",
      })
    ),
    {
      walletAddress: "",
      payoutChoice: "donate",
      splitPercent: null,
      charity: "Charity",
    }
  );

  assert.deepEqual(
    normalizeSubmissionPrivateData(
      formData({
        walletAddress: "wallet-b",
        payoutChoice: "split",
        splitPercent: 25,
        charity: "Charity",
      })
    ),
    {
      walletAddress: "wallet-b",
      payoutChoice: "split",
      splitPercent: 25,
      charity: "Charity",
    }
  );
});

test("invalid private combinations fail before R2 or database writes", () => {
  for (const values of [
    { payoutChoice: "keep", walletAddress: "" },
    { payoutChoice: "donate", charity: "" },
    {
      payoutChoice: "split",
      walletAddress: "wallet",
      charity: "Charity",
      splitPercent: 100,
    },
    { payoutChoice: "unknown", walletAddress: "wallet" },
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
    walletAddress: "wallet-a",
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
