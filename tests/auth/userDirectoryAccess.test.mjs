import assert from "node:assert/strict";
import test from "node:test";
import {
  BASIC_USER_DIRECTORY_SELECT,
  getUserDirectoryQuery,
} from "../../lib/admin/userDirectoryAccess.ts";

test("every authorized non-admin uses the explicit minimal user projection", () => {
  assert.deepEqual(getUserDirectoryQuery(false), {
    relation: "user_logs",
    select: BASIC_USER_DIRECTORY_SELECT,
    orderBy: "current_discord_username",
    isAdminView: false,
  });
});

test("the minimal projection excludes moderation history and sensitive fields", () => {
  for (const field of [
    "*",
    "known_discord_usernames",
    "flag_reason_code",
    "flag_note",
    "flagged_at",
    "flagged_by_discord_user_id",
    "ban_reason",
    "banned_at",
    "banned_by_discord_user_id",
    "unflag_reason",
    "unflagged_at",
    "unflagged_by_discord_user_id",
    "wallet",
    "session",
    "social",
  ]) {
    assert.equal(
      BASIC_USER_DIRECTORY_SELECT.includes(field),
      false,
      `basic directory unexpectedly includes ${field}`
    );
  }
});

test("hard admin retains the existing full administrative directory", () => {
  assert.deepEqual(getUserDirectoryQuery(true), {
    relation: "user_logs_with_stats",
    select: "*",
    orderBy: "last_seen_at",
    isAdminView: true,
  });
});
