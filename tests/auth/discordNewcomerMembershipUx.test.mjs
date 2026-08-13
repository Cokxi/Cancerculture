import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";

const state = {
  membership: null,
  membershipError: null,
};

mock.module(new URL("../../lib/auth/requireSession.ts", import.meta.url), {
  namedExports: {
    async requireSession() {
      return {
        discord_user_id: "server-only-discord-id",
        session_id: "server-only-session-id",
      };
    },
  },
});

mock.module(
  new URL("../../lib/eligibility/discordMembership.ts", import.meta.url),
  {
    namedExports: {
      async getDiscordMembershipEligibility() {
        if (state.membershipError) throw state.membershipError;
        return state.membership;
      },
    },
  }
);

const { GET } = await import("../../app/api/discord/check/route.ts");

function membership(overrides = {}) {
  return {
    isInDiscord: false,
    isEligible: false,
    isDiscordBanned: false,
    membershipKnown: true,
    dependencyUnavailable: false,
    membershipObservedAt: null,
    joinedAt: null,
    joinedTooRecently: false,
    retryAfterMs: 0,
    reason: "not_in_discord",
    ...overrides,
  };
}

test.beforeEach(() => {
  state.membership = membership();
  state.membershipError = null;
});

test("healthy newcomer absence exposes only the normal invite status", async () => {
  const response = await GET();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "NOT_IN_DISCORD" });
  assert.doesNotMatch(
    JSON.stringify(body),
    /discord_user_id|discordUsername|username|health|heartbeat|reconciliation|membershipObservedAt|server-only/iu
  );
});

test("polling can move the same session from invite to cooldown and then eligible", async () => {
  assert.deepEqual(await (await GET()).json(), {
    status: "NOT_IN_DISCORD",
  });

  const joinedAt = new Date(Date.now() - 60 * 1000).toISOString();
  state.membership = membership({
    isInDiscord: true,
    joinedAt,
    joinedTooRecently: true,
    retryAfterMs: 9 * 60 * 1000,
    reason: "joined_too_recently",
  });
  const cooldownResponse = await GET();
  const cooldownBody = await cooldownResponse.json();
  assert.deepEqual(cooldownBody, {
    status: "COOLDOWN",
    joinedAt,
    retryAfterMs: 9 * 60 * 1000,
  });
  assert.deepEqual(Object.keys(cooldownBody).sort(), [
    "joinedAt",
    "retryAfterMs",
    "status",
  ]);

  state.membership = membership({
    isInDiscord: true,
    isEligible: true,
    joinedAt,
    reason: null,
  });
  assert.deepEqual(await (await GET()).json(), { status: "OK" });
});

test("unknown and dependency-error paths remain fail-closed and privacy-safe", async () => {
  state.membership = membership({
    membershipKnown: false,
    reason: "membership_pending",
  });
  const pending = await GET();
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { status: "PENDING" });

  state.membership = membership({
    membershipKnown: false,
    dependencyUnavailable: true,
    reason: "membership_unavailable",
  });
  const unavailable = await GET();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "UNAVAILABLE" });

  state.membershipError = new Error("private provider failure");
  const failed = await GET();
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { status: "UNAVAILABLE" });
});

test("Upload and Vote preserve invite, polling, cooldown, and server-authoritative guards", async () => {
  const [uploadClient, voteClient, uploadRoute, voteRoute, membershipSource] =
    await Promise.all([
      readFile(
        new URL("../../app/components/upload/DesktopUpload.tsx", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../app/submissions/SubmissionsClient.tsx", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../../app/api/upload/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../../app/api/vote/route.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../lib/eligibility/discordMembership.ts", import.meta.url),
        "utf8"
      ),
    ]);

  assert.match(uploadClient, /href=\{DISCORD_INVITE_URL\}/u);
  assert.match(uploadClient, />\s*Join Discord\s*</u);
  assert.match(uploadClient, /const NOT_IN_DISCORD_POLL_MS = 12_000/u);
  assert.match(uploadClient, /router\.refresh\(\)/u);
  assert.doesNotMatch(uploadClient, /window\.location\.reload|location\.reload/u);
  assert.match(voteClient, /href=\{DISCORD_INVITE_URL\}/u);
  assert.match(voteClient, /Join Discord to Vote/u);
  assert.match(voteClient, /window\.setTimeout\(refreshSubmissionsPage, 10000\)/u);
  assert.match(voteClient, /<DiscordCooldownTimer/u);

  assert.match(uploadRoute, /const \{ session \} = await requireParticipation\(\)/u);
  assert.match(voteRoute, /const \{ membership, session \} = await requireParticipation\(\)/u);
  assert.ok(
    uploadRoute.indexOf("requireParticipation()") <
      uploadRoute.indexOf("req.formData()")
  );
  assert.ok(
    voteRoute.indexOf("requireParticipation()") <
      voteRoute.indexOf("req.formData()")
  );
  assert.match(
    membershipSource,
    /DISCORD_MEMBERSHIP_COOLDOWN_MINUTES = 10|DISCORD_MEMBERSHIP_COOLDOWN_MINUTES/u
  );
  assert.match(membershipSource, /health\.status === "healthy"/u);
  assert.doesNotMatch(
    `${uploadClient}\n${voteClient}`,
    /lastHeartbeatAt|lastFullReconciliationSucceededAt|lastFailureAt|discord_user_id|discordUsername/u
  );
});
