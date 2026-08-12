import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubmissionReportIdempotencyKey,
  SUBMISSION_REPORT_CREATE_ENDPOINT,
  SubmissionReportClientError,
  submitSubmissionReportFromClient,
} from "../../lib/reports/submissionReportClient.ts";

const input = Object.freeze({
  submissionId: 42,
  reason: "privacy_or_personal_information",
  subcategory: "doxxing",
  comment: "This exposes private location information.",
  idempotencyKey: "3d4f7a8e-4b35-4a0f-8f89-a36f12d4d5f1",
});

test("a confirmed client submission dispatches the report POST with its Turnstile token", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ reportId: "report-id" }, { status: 201 });
  };

  const result = await submitSubmissionReportFromClient(
    input,
    "verified-turnstile-token",
    fetchImpl,
  );

  assert.equal(result.response.status, 201);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, SUBMISSION_REPORT_CREATE_ENDPOINT);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(
    requests[0].init.headers["X-Turnstile-Token"],
    "verified-turnstile-token",
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), input);
});

test("client transport failures remain distinct from server report rejections", async () => {
  await assert.rejects(
    submitSubmissionReportFromClient(input, "verified-token", async () => {
      throw new TypeError("blocked before transport");
    }),
    (error) =>
      error instanceof SubmissionReportClientError &&
      error.message === "REPORT_NETWORK_ERROR",
  );
});

test("idempotency creation falls back to cryptographically random UUID v4", () => {
  const key = createSubmissionReportIdempotencyKey({
    getRandomValues(bytes) {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  });

  assert.equal(key, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("idempotency creation fails visibly without secure browser randomness", () => {
  assert.throws(
    () => createSubmissionReportIdempotencyKey({}),
    (error) =>
      error instanceof SubmissionReportClientError &&
      error.message === "REPORT_CLIENT_UNAVAILABLE",
  );
});
