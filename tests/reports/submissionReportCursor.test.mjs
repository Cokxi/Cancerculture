import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSubmissionReportCursor,
  parseSubmissionReportCursor,
} from "../../lib/reports/submissionReportCursor.ts";

const cursor = {
  createdAt: "2026-08-09T12:34:56.000Z",
  reportId: "3d4f7a8e-4b35-4a0f-8f89-a36f12d4d5f1",
};

test("My Reports cursors round-trip exact stable ordering facts", () => {
  assert.deepEqual(
    parseSubmissionReportCursor(encodeSubmissionReportCursor(cursor)),
    cursor
  );
});

test("My Reports cursors fail closed for malformed or expanded payloads", () => {
  for (const value of [
    "",
    "not-base64-json",
    Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString("base64url"),
    Buffer.from(JSON.stringify({ ...cursor, createdAt: "invalid" })).toString("base64url"),
    Buffer.from(JSON.stringify({ ...cursor, reportId: "invalid" })).toString("base64url"),
    "x".repeat(501),
  ]) {
    assert.equal(parseSubmissionReportCursor(value), null);
  }
});
