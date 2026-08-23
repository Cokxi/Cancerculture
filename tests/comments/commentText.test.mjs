import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCommunityCommentLinksAllowed,
  CommunityCommentTextError,
  normalizeCommunityCommentText,
  prepareCommunityCommentText,
} from "../../lib/comments/commentText.ts";

test("text is NFC-normalized with Unicode code-point and UTF-8 byte ceilings", () => {
  assert.equal(normalizeCommunityCommentText("  Cafe\u0301 😀\r\n\r\n\r\n\r\n  "), "Café 😀");
  assert.equal(Array.from(normalizeCommunityCommentText("😀".repeat(10_000))).length, 10_000);
  assert.throws(
    () => normalizeCommunityCommentText("a".repeat(10_001)),
    (error) => error instanceof CommunityCommentTextError && error.code === "TEXT_TOO_LONG"
  );
  assert.throws(
    () => normalizeCommunityCommentText("😀".repeat(10_000) + "a"),
    (error) => error instanceof CommunityCommentTextError && error.code === "TEXT_TOO_LONG"
  );
});

test("recognizable external links fail while internal and obfuscated text remain plain", () => {
  for (const body of [
    "https://example.com/x",
    "www.example.org",
    "example.net/path",
    "mailto:person@example.com",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => assertCommunityCommentLinksAllowed(body), {
      name: "CommunityCommentTextError",
      message: "EXTERNAL_LINK_REJECTED",
    });
  }
  for (const body of [
    "/spread/42",
    "https://cancerculture.fun/cycle-history",
    "example dot com",
  ]) assert.doesNotThrow(() => assertCommunityCommentLinksAllowed(body));
});

test("mentions are structured, non-overlapping, stable targets and never the whole body", () => {
  const target = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
  assert.deepEqual(prepareCommunityCommentText("Hi @Ada 😀", [{
    targetPublicProfileId: target,
    startIndex: 3,
    endIndex: 7,
  }]), {
    normalizedBody: "Hi @Ada 😀",
    normalizedMentions: [{ targetPublicProfileId: target, startIndex: 3, endIndex: 7 }],
  });
  assert.throws(
    () => prepareCommunityCommentText("@Ada", [{
      targetPublicProfileId: target,
      startIndex: 0,
      endIndex: 4,
    }]),
    (error) => error instanceof CommunityCommentTextError && error.code === "MENTION_ONLY_REJECTED"
  );
});
