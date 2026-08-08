import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeDisqualificationHistoryCursor,
  encodeDisqualificationProfileCursor,
  parseDisqualificationHistoryCursor,
  parseDisqualificationProfileCursor,
} from "../../lib/profile/disqualificationHistoryCursor.ts";

const at = "2026-08-09T10:20:30.000Z";
const eventId = "123e4567-e89b-42d3-a456-426614174000";

test("history cursors round-trip as opaque timestamp and UUID pairs", () => {
  const encoded = encodeDisqualificationHistoryCursor({ at, eventId });

  assert.equal(encoded.includes(at), false);
  assert.deepEqual(parseDisqualificationHistoryCursor(encoded), {
    at,
    eventId,
  });
});

test("profile cursors round-trip without exposing the internal Discord identity", () => {
  const publicProfileId = "223e4567-e89b-42d3-a456-426614174000";
  const encoded = encodeDisqualificationProfileCursor({
    at,
    publicProfileId,
  });

  assert.deepEqual(parseDisqualificationProfileCursor(encoded), {
    at,
    publicProfileId,
  });
});

test("malformed, partial, oversized, and non-canonical cursors fail closed", () => {
  const invalidValues = [
    "",
    "abc",
    "x".repeat(513),
    Buffer.from(JSON.stringify({ at }), "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({ at: "yesterday", eventId }),
      "utf8"
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify({ at, eventId: "not-a-uuid" }),
      "utf8"
    ).toString("base64url"),
  ];

  for (const value of invalidValues) {
    assert.equal(parseDisqualificationHistoryCursor(value), null);
  }

  const internalId = Buffer.from(
    JSON.stringify({ at, publicProfileId: "123456789012345678" }),
    "utf8"
  ).toString("base64url");
  assert.equal(parseDisqualificationProfileCursor(internalId), null);
});
