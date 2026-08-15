import assert from "node:assert/strict";
import test from "node:test";

process.env.SPONSOR_MEASUREMENT_HMAC_SECRET = "s".repeat(64);
const { createSponsorMeasurementGrant, verifySponsorMeasurementToken } =
  await import("../../lib/sponsors/measurementToken.server.ts");

test("Sponsor measurement tokens bind Feed kind, Submission, signature, and expiry", () => {
  const nowMs = Date.parse("2026-08-14T00:00:00.000Z");
  const grant = createSponsorMeasurementGrant({
    feed: "all",
    submissionId: 42,
    cycleNumber: 7,
    nowMs,
  });
  assert.equal(typeof grant.token, "string");
  assert.equal(grant.expiresAt, "2026-08-14T00:30:00.000Z");
  const token = grant.token;
  assert.equal(
    verifySponsorMeasurementToken({
      token,
      feed: "all",
      submissionId: 42,
      cycleNumber: 7,
      nowMs,
    }),
    true,
  );
  assert.equal(
    verifySponsorMeasurementToken({
      token,
      feed: "trash",
      submissionId: 42,
      cycleNumber: 7,
      nowMs,
    }),
    false,
  );
  assert.equal(
    verifySponsorMeasurementToken({
      token,
      feed: "all",
      submissionId: 43,
      cycleNumber: 7,
      nowMs,
    }),
    false,
  );
  assert.equal(
    verifySponsorMeasurementToken({
      token: `${token}x`,
      feed: "all",
      submissionId: 42,
      cycleNumber: 7,
      nowMs,
    }),
    false,
  );
  assert.equal(
    verifySponsorMeasurementToken({
      token,
      feed: "all",
      submissionId: 42,
      cycleNumber: 7,
      nowMs: nowMs + 30 * 60 * 1000 + 1,
    }),
    false,
  );
  assert.equal(
    verifySponsorMeasurementToken({
      token,
      feed: "all",
      submissionId: 42,
      cycleNumber: 8,
      nowMs,
    }),
    false,
  );
});
