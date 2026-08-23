import assert from "node:assert/strict";
import test from "node:test";
import { parseCommunityCommentPublicDto } from "../../lib/comments/commentDto.ts";

const id = "018f0ed0-5c89-4c0f-9c38-8cebd4e18422";
const base = {
  publicCommentId: id,
  submissionId: 12,
  rootPublicCommentId: null,
  replyTargetPublicCommentId: null,
  version: 1,
  createdAt: "2026-08-23T12:00:00.000Z",
  edited: false,
  editedAt: null,
  tombstone: null,
  body: "Hello",
  author: { publicProfileId: id, displayName: "Ada", isCreator: true, isBanned: false },
  mentions: [],
  replyCount: 0,
};

test("public Comment DTO accepts only the narrow current projection", () => {
  assert.deepEqual(parseCommunityCommentPublicDto(base), base);
  for (const privateKey of ["discordUserId", "oldBody", "banReason", "ipAddress", "reportCount"]) {
    assert.throws(() => parseCommunityCommentPublicDto({ ...base, [privateKey]: "leak" }), {
      message: "COMMUNITY_COMMENT_PUBLIC_DTO_INVALID",
    });
  }
  assert.throws(() => parseCommunityCommentPublicDto({
    ...base,
    author: { ...base.author, previousDisplayName: "Old Ada" },
  }));
});

test("author tombstones remove body and current mentions", () => {
  const tombstone = { ...base, version: 2, tombstone: "author_deleted", body: null, mentions: [] };
  assert.deepEqual(parseCommunityCommentPublicDto(tombstone), tombstone);
  assert.throws(() => parseCommunityCommentPublicDto({ ...tombstone, body: "old text" }));
});
