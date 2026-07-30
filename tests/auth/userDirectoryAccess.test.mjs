import assert from "node:assert/strict";
import test from "node:test";
import {
  BASIC_USER_DIRECTORY_SELECT,
  getUserDirectoryQuery,
} from "../../lib/admin/userDirectoryAccess.ts";

const lowerTeamRoles = [
  "trial_moderator",
  "moderator",
  "super_moderator",
];

test("lower team roles use the same explicit minimal user projection", () => {
  for (const role of lowerTeamRoles) {
    assert.deepEqual(getUserDirectoryQuery(role), {
      relation: "user_logs",
      select: BASIC_USER_DIRECTORY_SELECT,
      orderBy: "current_discord_username",
      isAdminView: false,
    });
  }
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

test("admin retains the existing full administrative directory", () => {
  assert.deepEqual(getUserDirectoryQuery("admin"), {
    relation: "user_logs_with_stats",
    select: "*",
    orderBy: "last_seen_at",
    isAdminView: true,
  });
});
