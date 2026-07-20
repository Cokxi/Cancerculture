import assert from "node:assert/strict";
import test from "node:test";
import { decideDiscordSyncParticipationGrace } from "../../lib/eligibility/discordSyncParticipationGrace.ts";

const NOW = new Date("2026-07-18T12:00:00.000Z");

const beforeNow = (ageMs) =>
  new Date(NOW.getTime() - ageMs).toISOString();

const baseInput = (overrides = {}) => ({
  now: NOW,
  syncHealthStatus: "degraded",
  existingDecision: {
    allowed: false,
    reason: "membership_pending",
  },
  isInDiscord: true,
  membershipObservedAt: beforeNow(91 * 60 * 1000),
  joinedAt: beforeNow(24 * 60 * 60 * 1000),
  websiteBanned: false,
  discordBanned: false,
  sessionStatus: "valid",
  dependencyUnavailable: false,
  ...overrides,
});

test("healthy preserves an existing blocked decision unchanged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ syncHealthStatus: "healthy" })
  );

  assert.deepEqual(result, {
    allowed: false,
    mode: "preserve_existing_decision",
    reason: "membership_pending",
    usedDegradedGrace: false,
  });
});

test("degraded allows a confirmed member blocked only by stale observation", () => {
  const result = decideDiscordSyncParticipationGrace(baseInput());

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "confirmed_member_sync_stale");
});

test("offline allows the same confirmed established member", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ syncHealthStatus: "offline" })
  );

  assert.equal(result.allowed, true);
  assert.equal(result.mode, "degraded_grace");
});

test("grace use is marked explicitly", () => {
  const result = decideDiscordSyncParticipationGrace(baseInput());

  assert.deepEqual(result, {
    allowed: true,
    mode: "degraded_grace",
    reason: "confirmed_member_sync_stale",
    usedDegradedGrace: true,
  });
});

test("fresh eligible membership preserves access without grace", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      existingDecision: { allowed: true, reason: null },
      membershipObservedAt: beforeNow(5 * 60 * 1000),
    })
  );

  assert.deepEqual(result, {
    allowed: true,
    mode: "preserve_existing_decision",
    reason: "existing_decision_allowed",
    usedDegradedGrace: false,
  });
});

test("isInDiscord false is never allowed", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      existingDecision: { allowed: false, reason: "not_in_discord" },
      isInDiscord: false,
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "not_in_discord");
});

test("a missing membership observation is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ membershipObservedAt: null })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "membership_observation_missing");
});

test("an invalid membership observation is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ membershipObservedAt: "not-a-date" })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "membership_observation_invalid");
});

test("a future membership observation is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      membershipObservedAt: new Date(
        NOW.getTime() + 1
      ).toISOString(),
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "membership_observation_future");
});

test("a join wait below ten minutes is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ joinedAt: beforeNow(10 * 60 * 1000 - 1) })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "joined_too_recently");
});

test("an exactly completed ten-minute join wait permits grace", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ joinedAt: beforeNow(10 * 60 * 1000) })
  );

  assert.equal(result.allowed, true);
  assert.equal(result.usedDegradedGrace, true);
});

test("a Website ban is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ websiteBanned: true })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "website_banned");
});

test("a hard ban overrides an inconsistent allowed input", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      syncHealthStatus: "healthy",
      existingDecision: { allowed: true, reason: null },
      websiteBanned: true,
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "website_banned");
  assert.equal(result.usedDegradedGrace, false);
});

test("a Discord ban is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ discordBanned: true })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "discord_banned");
});

test("a revoked session is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ sessionStatus: "revoked" })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "session_revoked");
});

test("an invalid session is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ sessionStatus: "invalid" })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "session_invalid");
});

test("a technical dependency failure is never bridged", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({ dependencyUnavailable: true })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "dependency_unavailable");
});

test("a new user without a confirmed database join remains pending", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      isInDiscord: false,
      membershipObservedAt: null,
      joinedAt: null,
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.mode, "pending");
  assert.equal(result.reason, "pending_new_or_rejoining_member");
});

test("a rejoin without a confirmed new join remains pending", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      isInDiscord: false,
      membershipObservedAt: beforeNow(7 * 24 * 60 * 60 * 1000),
      joinedAt: beforeNow(7 * 24 * 60 * 60 * 1000),
    })
  );

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "pending_new_or_rejoining_member");
});

test("stale confirmed membership has no automatic 24-hour cutoff", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      membershipObservedAt: beforeNow(365 * 24 * 60 * 60 * 1000),
    })
  );

  assert.equal(result.allowed, true);
  assert.equal(result.mode, "degraded_grace");
});

test("an invalid or future join timestamp is never bridged", () => {
  const malformed = decideDiscordSyncParticipationGrace(
    baseInput({ joinedAt: "not-a-date" })
  );
  const future = decideDiscordSyncParticipationGrace(
    baseInput({
      joinedAt: new Date(NOW.getTime() + 1).toISOString(),
    })
  );

  assert.equal(malformed.reason, "join_timestamp_invalid");
  assert.equal(future.reason, "join_timestamp_invalid");
  assert.equal(malformed.allowed, false);
  assert.equal(future.allowed, false);
});

test("a non-membership-pending denial is preserved, not overridden", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      existingDecision: {
        allowed: false,
        reason: "membership_unavailable",
      },
    })
  );

  assert.deepEqual(result, {
    allowed: false,
    mode: "preserve_existing_decision",
    reason: "membership_unavailable",
    usedDegradedGrace: false,
  });
});

test("inputs and Date instances are not mutated", () => {
  const now = new Date(NOW);
  const observation = new Date(NOW.getTime() - 91 * 60 * 1000);
  const joined = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const input = baseInput({
    now,
    membershipObservedAt: observation,
    joinedAt: joined,
  });
  const before = {
    input: { ...input, existingDecision: { ...input.existingDecision } },
    now: now.getTime(),
    observation: observation.getTime(),
    joined: joined.getTime(),
  };

  decideDiscordSyncParticipationGrace(input);

  assert.deepEqual(input, before.input);
  assert.equal(now.getTime(), before.now);
  assert.equal(observation.getTime(), before.observation);
  assert.equal(joined.getTime(), before.joined);
});

test("hard-block reason precedence is deterministic", () => {
  const result = decideDiscordSyncParticipationGrace(
    baseInput({
      sessionStatus: "revoked",
      dependencyUnavailable: true,
      websiteBanned: true,
      discordBanned: true,
    })
  );

  assert.equal(result.reason, "session_revoked");
  assert.equal(result.mode, "blocked");
});
