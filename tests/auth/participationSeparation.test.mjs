import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createParticipationAccessState } from "../../lib/eligibility/participation.ts";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("participation states keep authentication separate from membership", () => {
  assert.equal(createParticipationAccessState().status, "anonymous");
  assert.equal(
    createParticipationAccessState({ authenticated: true }).status,
    "membership_pending"
  );
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      membershipKnown: true,
    }).status,
    "not_in_discord"
  );
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      membershipKnown: true,
      discordMember: true,
      joinWaitActive: true,
    }).status,
    "join_wait"
  );
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      membershipKnown: true,
      discordMember: true,
    }).status,
    "eligible"
  );
});

test("only bans produce the restricted participation state", () => {
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      websiteBanned: true,
    }).status,
    "restricted"
  );
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      discordBanned: true,
    }).status,
    "restricted"
  );
  assert.equal(
    createParticipationAccessState({
      authenticated: true,
      dependencyUnavailable: true,
    }).status,
    "dependency_unavailable"
  );
});

test("participation holds remain distinct from membership failures", async () => {
  const held = createParticipationAccessState({
    authenticated: true,
    membershipKnown: true,
    discordMember: true,
    participationHeld: true,
  });
  const released = createParticipationAccessState({
    authenticated: true,
    membershipKnown: true,
    discordMember: true,
    participationHeld: false,
  });

  assert.equal(held.status, "temporarily_unavailable");
  assert.equal(held.participationHeld, true);
  assert.equal(held.membershipKnown, true);
  assert.equal(held.discordMember, true);
  assert.equal(released.status, "eligible");

  const migration = await readRepoFile(
    "supabase/migrations/20260801000100_user_flag_escalation_workflow.sql"
  );
  const holdFunction = migration.slice(
    migration.indexOf("create or replace function public.is_user_participation_held"),
    migration.indexOf("create or replace function public.get_user_participation_hold")
  );
  assert.match(holdFunction, /status = 'escalated'/u);
  assert.doesNotMatch(holdFunction, /status = '(?:open|resolved|dismissed)'/u);
});

test("public upload and submissions pages contain no automatic OAuth redirect", async () => {
  const [uploadPage, submissionsPage] = await Promise.all([
    readRepoFile("app/upload/page.tsx"),
    readRepoFile("app/submissions/page.tsx"),
  ]);

  for (const source of [uploadPage, submissionsPage]) {
    assert.doesNotMatch(source, /redirect\([^)]*api\/auth\/discord\/login/);
    assert.doesNotMatch(source, /useEffect[\s\S]*api\/auth\/discord\/login/);
  }
});

test("OAuth callback blocks bans but not membership outcomes", async () => {
  const source = await readRepoFile(
    "app/api/auth/discord/callback/route.ts"
  );
  const deniedMapping = source.slice(
    source.indexOf("const deniedCode"),
    source.indexOf("const deniedStatus")
  );

  assert.match(deniedMapping, /discord_banned/);
  assert.match(deniedMapping, /website_banned/);
  assert.doesNotMatch(deniedMapping, /not_in_discord/);
  assert.doesNotMatch(deniedMapping, /joined_too_recently/);
});

test("upload and vote commits use the participation guard", async () => {
  const [uploadRoute, voteRoute] = await Promise.all([
    readRepoFile("app/api/upload/route.ts"),
    readRepoFile("app/api/vote/route.ts"),
  ]);

  assert.match(uploadRoute, /await requireParticipation\(\)/);
  assert.match(voteRoute, /await requireParticipation\(\)/);
});

test("upload and vote UX expose every non-eligible state", async () => {
  const [uploadClient, submissionsClient, notice] = await Promise.all([
    readRepoFile("app/components/upload/DesktopUpload.tsx"),
    readRepoFile("app/submissions/SubmissionsClient.tsx"),
    readRepoFile("lib/eligibility/participationNotice.ts"),
  ]);

  assert.match(uploadClient, /Login with Discord to upload/);
  assert.match(uploadClient, /Join Discord to upload/);
  assert.match(uploadClient, /temporarily verifying your Discord membership/);
  assert.match(uploadClient, /DiscordCooldownTimer/);
  assert.match(submissionsClient, /Login with Discord to vote/);
  assert.match(submissionsClient, /Join Discord to vote/);
  assert.match(submissionsClient, /Membership verification is temporarily pending/);
  assert.match(submissionsClient, /DiscordCooldownTimer/);
  assert.match(uploadClient, /status === "temporarily_unavailable"/u);
  assert.match(submissionsClient, /status === "temporarily_unavailable"/u);
  assert.match(submissionsClient, /"participation_hold"/u);
  assert.match(notice, /Your participation is temporarily on hold/u);
  assert.match(
    notice,
    /Your account is currently under review\. You can continue to browse CancerCulture, but uploading and voting are unavailable until the review is complete\./u
  );
  assert.doesNotMatch(
    notice,
    /suspicious_behavior|escalation|actor|category|internal reason/iu
  );
});

test("logout revokes the server session before clearing the cookie", async () => {
  const source = await readRepoFile("app/api/auth/logout/route.ts");
  const revocation = source.indexOf('.from("sessions")');
  const cookieExpiry = source.indexOf('expireCookie(response, "session_id")');

  assert.ok(revocation > -1);
  assert.ok(cookieExpiry > revocation);
  assert.match(source, /NextResponse\.redirect\([\s\S]*303/);
  assert.match(source, /sanitizeInternalReturnPath/);
});

test("session migration allows restricted sessions while retaining ban checks", async () => {
  const source = await readRepoFile(
    "supabase/migrations/20260717000700_auth_participation_separation.sql"
  );
  const createSession = source.slice(
    source.indexOf("create or replace function public.create_cancerculture_session"),
    source.indexOf("comment on function public.get_cancerculture_session_access")
  );

  assert.match(createSession, /discord_ban_active/);
  assert.match(createSession, /v_user\.is_banned/);
  assert.match(createSession, /insert into public\.sessions/);
  assert.doesNotMatch(createSession, /return jsonb_build_object\('outcome', 'not_in_discord'\)/);
  assert.doesNotMatch(createSession, /return jsonb_build_object\([\s\S]*?'outcome', 'joined_too_recently'/);
});

test("member removal and complete snapshot absence retain sessions while bans revoke them", async () => {
  const source = await readRepoFile(
    "supabase/migrations/20260717000700_auth_participation_separation.sql"
  );
  const liveEvent = source.slice(
    source.indexOf("create or replace function public.apply_discord_live_event"),
    source.indexOf("create or replace function public.finalize_discord_reconciliation_snapshot")
  );
  const finalize = source.slice(
    source.indexOf("create or replace function public.finalize_discord_reconciliation_snapshot"),
    source.indexOf("create or replace function public.get_cancerculture_session_access")
  );
  const removeBranch = liveEvent.slice(
    liveEvent.indexOf("elsif p_event_type = 'member_removed'"),
    liveEvent.indexOf("elsif p_event_type = 'ban_added'")
  );
  const banBranch = liveEvent.slice(
    liveEvent.indexOf("elsif p_event_type = 'ban_added'"),
    liveEvent.indexOf("elsif p_event_type = 'ban_removed'")
  );
  const snapshotAbsentBranch = finalize.slice(
    finalize.lastIndexOf("else\n        update public.discord_member_state"),
    finalize.indexOf("end if;\n    end if;\n  end loop;")
  );

  assert.match(removeBranch, /is_in_discord = false/);
  assert.doesNotMatch(removeBranch, /update public\.sessions/);
  assert.match(banBranch, /update public\.sessions/);
  assert.match(snapshotAbsentBranch, /is_in_discord = false/);
  assert.doesNotMatch(snapshotAbsentBranch, /update public\.sessions/);
  assert.match(finalize, /if v_member_count <> v_snapshot\.expected_member_count/);
  assert.match(source, /create or replace function public\.revoke_website_ban_sessions/);
  assert.match(source, /after insert or update of is_banned/);
});

test("global account and lazy vote eligibility stay separated", async () => {
  const [account, accountRoute, voteClient, eligibilityRoute] = await Promise.all([
    readRepoFile("app/components/auth/GlobalAccount.tsx"),
    readRepoFile("app/api/auth/account/route.ts"),
    readRepoFile("app/submissions/SubmissionsClient.tsx"),
    readRepoFile("app/api/vote/eligibility/route.ts"),
  ]);

  assert.doesNotMatch(`${account}\n${accountRoute}`, /getDiscordMembershipEligibility/);
  assert.match(account, /method="post"/);
  assert.match(accountRoute, /"Cache-Control": "no-store"/);
  assert.match(voteClient, /cache: "no-store"/);
  assert.match(eligibilityRoute, /export const dynamic = "force-dynamic"/);
  assert.match(eligibilityRoute, /Cache-Control", "no-store"/);
});
