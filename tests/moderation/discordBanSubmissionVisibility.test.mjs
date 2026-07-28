import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("migration uses one Ban enforcement path and never schedules media cleanup", async () => {
  const migration = await source(
    "supabase/migrations/20260716000200_discord_ban_submission_enforcement.sql"
  );

  assert.match(migration, /enforce_discord_ban_submissions\(/);
  assert.match(
    migration,
    /discord_member_state_submission_enforcement_trigger/
  );
  assert.match(migration, /public_visibility_status = 'removed'/);
  assert.match(
    migration,
    /disqualification_type = case[\s\S]*then 'discord_ban'/
  );
  assert.match(migration, /cycle-finalization:/);
  assert.match(migration, /cycle-reset:/);
  assert.doesNotMatch(migration, /insert into public\.media_cleanup_queue/i);
  assert.doesNotMatch(migration, /delete from public\.winner_public_profiles/i);
  assert.doesNotMatch(migration, /delete from public\.cycle_results/i);
});

test("public Submission and wall queries use fail-closed visibility filters", async () => {
  const [
    submissionsPage,
    voteSubmissions,
    wallHelper,
    publicProfile,
    history,
  ] = await Promise.all([
    source("lib/vote/getVoteSubmissions.ts"),
    source("lib/vote/getVoteSubmissions.ts"),
    source("lib/walls/getPublicWallPage.ts"),
    source("lib/profile/getPublicUserProfileData.ts"),
    source("lib/cycles/getCycleHistoryData.ts"),
  ]);

  assert.match(submissionsPage, /\.from\("submissions"\)/);
  assert.match(voteSubmissions, /public_visibility_status", "visible"/);
  assert.match(
    voteSubmissions,
    /is_disqualified\.is\.null,is_disqualified\.eq\.false/
  );
  assert.match(wallHelper, /SUBMISSION_PUBLIC_VISIBILITY\.visible/);
  assert.match(wallHelper, /visibleSubmissions/);
  assert.match(wallHelper, /visibleRows/);

  assert.match(publicProfile, /if \(visibilityRowsResult\.error\)/);
  assert.match(publicProfile, /if \(!visibility\)/);
  assert.match(history, /isSubmissionListedPublicly/);
});

test("Admin republish requires Admin, a fresh Unban, review confirmation, audit RPC, and cache invalidation", async () => {
  const [route, syncRoute, reviewPage, helper, reviewActions, visibilityHelper] =
    await Promise.all([
      source("app/api/admin/submissions/republish/route.ts"),
      source("app/api/internal/discord/membership-sync/route.ts"),
      source("app/admin/moderation/legal-review/page.tsx"),
      source("lib/moderation/republishDiscordBanSubmission.ts"),
      source(
        "app/admin/moderation/legal-review/review-actions.tsx"
      ),
      source("lib/moderation/setSubmissionPublicVisibility.ts"),
    ]);

  assert.match(route, /requireAdmin\(\)/);
  assert.match(route, /manualReviewConfirmed/);
  assert.match(route, /reason\.length < 10/);
  assert.match(route, /revalidatePath\("\/submissions"\)/);
  assert.match(route, /revalidatePath\("\/admin\/moderation\/legal-review"\)/);
  assert.match(route, /revalidatePath\("\/wall\/fame"\)/);
  assert.match(syncRoute, /eventType === "ban_removed"/);
  assert.match(syncRoute, /revalidatePath\("\/admin\/moderation\/legal-review"\)/);
  assert.match(reviewPage, /discord_ban_active/);
  assert.match(
    helper,
    /republish_discord_ban_submission/
  );
  assert.match(reviewActions, /Mandatory review reason/);
  assert.match(reviewActions, /manually reviewed/);
  assert.match(reviewActions, /discordBanActive/);
  assert.match(reviewActions, /Republish stays locked while the Discord ban is active/);
  assert.match(
    visibilityHelper,
    /DISCORD_BAN_REPUBLISH_REQUIRES_REVIEW/
  );
});

test("Vote and finalization retain stable competition barriers", async () => {
  const [migration, finalization] = await Promise.all([
    source(
      "supabase/migrations/20260716000200_discord_ban_submission_enforcement.sql"
    ),
    source(
      "supabase/migrations/20260714000100_transactional_cycle_finalization.sql"
    ),
  ]);

  assert.match(
    migration,
    /SUBMISSION_NOT_COMPETITION_ELIGIBLE/
  );
  assert.match(migration, /from public\.submissions[\s\S]*for update/);
  assert.match(
    finalization,
    /coalesce\(s\.is_disqualified, false\) = false/
  );
  assert.match(
    finalization,
    /public_visibility_status_at_finalization/
  );
});
