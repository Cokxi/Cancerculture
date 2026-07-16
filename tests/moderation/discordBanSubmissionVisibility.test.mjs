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
    famePage,
    shamePage,
    publicProfile,
    history,
  ] = await Promise.all([
    source("app/submissions/page.tsx"),
    source("lib/vote/getVoteSubmissions.ts"),
    source("app/wall/fame/page.tsx"),
    source("app/wall/shame/page.tsx"),
    source("lib/profile/getPublicUserProfileData.ts"),
    source("lib/cycles/getCycleHistoryData.ts"),
  ]);

  assert.match(submissionsPage, /public_submissions_with_votes/);
  assert.match(voteSubmissions, /public_submissions_with_votes/);

  for (const wallPage of [famePage, shamePage]) {
    assert.match(wallPage, /SUBMISSION_PUBLIC_VISIBILITY\.visible/);
    assert.match(wallPage, /visibleSubmissionIds/);
    assert.match(wallPage, /visibleWinners/);
  }

  assert.match(publicProfile, /if \(visibilityRowsResult\.error\)/);
  assert.match(publicProfile, /if \(!visibility\)/);
  assert.match(history, /isSubmissionListedPublicly/);
});

test("Admin republish requires Admin, reason, confirmation, audit RPC, and cache invalidation", async () => {
  const [route, helper, reviewActions, visibilityHelper] =
    await Promise.all([
      source("app/api/admin/submissions/republish/route.ts"),
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
  assert.match(route, /revalidatePath\("\/wall\/fame"\)/);
  assert.match(
    helper,
    /republish_discord_ban_submission/
  );
  assert.match(reviewActions, /Mandatory review reason/);
  assert.match(reviewActions, /manually reviewed/);
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
