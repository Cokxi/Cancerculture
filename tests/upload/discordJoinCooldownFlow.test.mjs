import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../app/components/upload/DesktopUpload.tsx", import.meta.url),
  "utf8"
);

test("not_in_discord keeps the upload page mounted and disables editing", () => {
  assert.doesNotMatch(source, /if \(!canUseForm\)\s*{\s*return/);
  assert.match(source, /participationState\.status !== "eligible"/);
  assert.match(source, /Join Discord to upload/);
  assert.match(
    source,
    /You need to be a member of our Discord before participating\.[\s\S]*After joining, a 10-minute waiting period applies\./
  );
  assert.match(source, /disabled={!hasActiveCycle \|\| !canUseForm}/);
  assert.match(
    source,
    /const canUseForm =[\s\S]*"eligible"[\s\S]*"join_wait"/
  );
});

test("join_wait permits preparation but keeps submission gated", () => {
  assert.match(
    source,
    /You’re almost ready[\s\S]*You can prepare your submission now\. The upload button will[\s\S]*unlock when the countdown ends\./
  );
  assert.doesNotMatch(source, /while the join wait finishes/);
  assert.match(source, /<DiscordCooldownTimer/);
  assert.match(source, /const canSubmit = participationState\.status === "eligible"/);
  assert.match(source, /if \(!canSubmit\) return/);
});

test("timer completion confirms membership without destructive navigation", () => {
  const completionHandler = source.slice(
    source.indexOf("const handleCooldownComplete"),
    source.indexOf("useEffect(() =>", source.indexOf("const handleCooldownComplete"))
  );

  assert.match(source, /setCompletedCooldownKey\(cooldownKey\)/);
  assert.match(source, /Confirming your Discord membership&hellip;/);
  assert.equal(completionHandler.match(/refreshEligibility\(\)/g)?.length, 1);
  assert.match(completionHandler, /document\.visibilityState === "visible"/);
  assert.doesNotMatch(source, /window\.location\.reload|location\.reload/);
  assert.doesNotMatch(source, /router\.(?:push|replace)\([^)]*upload/);
});

test("eligible removes the integrated Discord status section", () => {
  const statusStart = source.indexOf(
    '{participationState.status !== "eligible" ? ('
  );
  const formStart = source.indexOf("{!uploadDone &&", statusStart);

  assert.ok(statusStart > -1);
  assert.ok(formStart > statusStart);
  assert.match(source.slice(statusStart, formStart), /<section/);
});

test("form state survives every polled membership transition", () => {
  const firstFormState = source.indexOf("const [file, setFile]");
  const statusBranch = source.indexOf(
    '{participationState.status !== "eligible" ? ('
  );

  assert.ok(firstFormState > -1 && firstFormState < statusBranch);
  for (const stateName of [
    "previewUrl",
    "walletAddress",
    "payoutChoice",
    "splitPercent",
    "charity",
    "customCharity",
  ]) {
    assert.match(source.slice(0, statusBranch), new RegExp(`\\[${stateName},`));
  }
  assert.match(source, /router\.refresh\(\)/);
  assert.doesNotMatch(source, /window\.location\.reload|location\.reload/);
});

test("sync delay notice replaces the contradictory join claim", () => {
  const delayBranch = source.slice(
    source.indexOf("{showDiscordSyncDelayNotice &&"),
    source.indexOf(') : participationState.status === "not_in_discord"')
  );

  assert.match(delayBranch, /DiscordSyncDelayNotice/);
  assert.match(delayBranch, /Open Discord/);
  assert.doesNotMatch(delayBranch, /Join Discord to upload|need to be a member/);
});

test("periodic polling uses slow status-specific visible-tab intervals", () => {
  const pollingEffectStart = source.indexOf("const isHealthyNotInDiscord");
  const pollingEffect = source.slice(
    pollingEffectStart,
    source.indexOf(
      "useEffect(() => {\n    if (\n      participationState.status !== \"join_wait\"",
      pollingEffectStart
    )
  );

  for (const status of ["not_in_discord", "membership_pending"]) {
    assert.match(pollingEffect, new RegExp(`status === "${status}"`));
  }
  for (const finalStatus of ["join_wait", "eligible", "restricted", "dependency_unavailable"]) {
    assert.doesNotMatch(pollingEffect, new RegExp(`status === "${finalStatus}"`));
  }
  assert.match(source, /const NOT_IN_DISCORD_POLL_MS = 12_000/);
  assert.match(source, /const MEMBERSHIP_PENDING_POLL_MS = 25_000/);
  assert.match(pollingEffect, /document\.visibilityState !== "visible"/);
  assert.match(
    pollingEffect,
    /window\.setInterval\([\s\S]*refreshEligibility,[\s\S]*pollIntervalMs/
  );
  assert.doesNotMatch(source, /setInterval\([^)]*,\s*5000\)/);
  assert.match(pollingEffect, /window\.clearInterval\(intervalId\)/);
  assert.match(pollingEffect, /removeEventListener\([\s\S]*visibilitychange/);
  assert.match(pollingEffect, /addEventListener\("focus", handleFocus\)/);
  assert.match(pollingEffect, /removeEventListener\("focus", handleFocus\)/);
});

test("join_wait has no interval and confirmation retries are bounded", () => {
  const retryEffect = source.slice(
    source.indexOf('participationState.status !== "join_wait"'),
    source.indexOf("const walletDisabled")
  );

  assert.doesNotMatch(retryEffect, /setInterval/);
  assert.match(
    source,
    /const CONFIRMATION_RETRY_DELAYS_MS = \[2_000, 5_000, 10_000\] as const/
  );
  assert.match(retryEffect, /!firstConfirmationResponseObserved/);
  assert.match(retryEffect, /CONFIRMATION_RETRY_DELAYS_MS\.map/);
  assert.match(retryEffect, /window\.setTimeout/);
  assert.match(retryEffect, /window\.clearTimeout/);
  assert.match(retryEffect, /document\.visibilityState === "visible"/);
  assert.match(retryEffect, /removeEventListener\([\s\S]*visibilitychange/);
});
