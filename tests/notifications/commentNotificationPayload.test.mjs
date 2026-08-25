import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenericPushPayload,
  getServiceWorkerPushAllowlist,
} from "../../lib/notifications/pushPayload.ts";

const notificationId = "11111111-1111-4111-8111-111111111111";

test("Reply and Mention Push payloads are generic and category-bound", () => {
  assert.deepEqual(buildGenericPushPayload({
    eventType: "comment_reply",
    categoryKey: "comment_replies",
    notificationId,
  }), {
    title: "New comment reply",
    body: "You have a new reply.",
    category: "comment_replies",
    notificationId,
  });
  assert.deepEqual(buildGenericPushPayload({
    eventType: "comment_mention",
    categoryKey: "comment_mentions",
    notificationId,
  }), {
    title: "New comment mention",
    body: "You were mentioned.",
    category: "comment_mentions",
    notificationId,
  });
  assert.throws(() => buildGenericPushPayload({
    eventType: "comment_reply",
    categoryKey: "comment_mentions",
    notificationId,
  }), /PUSH_PAYLOAD_INVALID/u);
});

test("the Service Worker allowlist contains no Comment, author, or Submission content", () => {
  const commentEntries = getServiceWorkerPushAllowlist().filter((entry) =>
    entry.categoryKey === "comment_replies" || entry.categoryKey === "comment_mentions"
  );
  assert.equal(commentEntries.length, 2);
  const serialized = JSON.stringify(commentEntries);
  assert.doesNotMatch(serialized, /discord|submission title|comment body|moderation|wallet/iu);
});
