import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const [
  adminPanel,
  adminRoute,
  startRoute,
  sponsorModel,
  feedComponent,
  detailComponent,
  cleanup,
] = await Promise.all([
  readFile(new URL("app/admin/cycles/SponsoredCycleDraftPanel.tsx", root), "utf8"),
  readFile(new URL("app/api/admin/cycles/sponsored-draft/route.ts", root), "utf8"),
  readFile(new URL("app/api/admin/cycles/start/route.ts", root), "utf8"),
  readFile(new URL("lib/cycles/sponsoredCycle.ts", root), "utf8"),
  readFile(new URL("app/spread/CommunityFeedSponsor.tsx", root), "utf8"),
  readFile(new URL("app/components/SponsoredBanner.tsx", root), "utf8"),
  readFile(new URL("lib/r2/processMediaCleanupQueue.ts", root), "utf8"),
]);

test("one Admin save owns both independent banner roles and revision state", () => {
  assert.match(adminPanel, /DETAIL BANNER · 2:1/u);
  assert.match(adminPanel, /THE SPREAD STRIP · 6:1/u);
  assert.match(adminPanel, /formData\.append\("detailBanner"/u);
  assert.match(adminPanel, /formData\.append\("feedBanner"/u);
  assert.match(adminPanel, /formData\.append\("idempotencyKey", crypto\.randomUUID\(\)\)/u);
  assert.match(adminPanel, /formData\.append\("revision"/u);
  assert.equal(
    (adminPanel.match(/fetch\("\/api\/admin\/cycles\/sponsored-draft"/gu) ?? []).length,
    1
  );
});

test("upload reservation precedes storage and atomically commits or aborts", () => {
  const reserve = adminRoute.indexOf('"reserve_sponsor_media_upload"');
  const storage = adminRoute.indexOf("new PutObjectCommand");
  const commit = adminRoute.indexOf('"commit_sponsor_media_upload"');
  assert.ok(reserve >= 0 && reserve < storage && storage < commit);
  assert.match(adminRoute, /abort_sponsor_media_upload/u);
  assert.match(adminRoute, /expectedRevision !== existingDraft\.revision/u);
  assert.doesNotMatch(adminRoute, /\.from\("cycle_sponsorships"\)[\s\S]*\.(?:insert|update|delete)\(/u);
});

test("activation and public DTOs fail closed without a complete pair", () => {
  assert.match(
    startRoute,
    /detailBannerR2Key\.length === 0[\s\S]*feedBannerR2Key\.length === 0/u
  );
  const publicDraft = sponsorModel.slice(
    sponsorModel.indexOf("export type SponsoredCycleDraft ="),
    sponsorModel.indexOf("export type SponsoredCycleDraftInternal =")
  );
  assert.doesNotMatch(
    publicDraft,
    /\bsponsorLink\s*:|R2Key|sponsorshipId|bucket/iu
  );
  assert.match(publicDraft, /hasSponsorLink/u);
  assert.match(publicDraft, /detailBanner/u);
  assert.match(publicDraft, /feedBanner/u);
});

test("shared detail presentation validates its selected exact ratio while inline Feed stays 6:1", () => {
  assert.match(detailComponent, /format\?: "detail" \| "feed"/u);
  assert.match(detailComponent, /format === "feed" \? 6 : 2/u);
  assert.match(detailComponent, /"aspect-\[6\/1\]" : "aspect-\[2\/1\]"/u);
  assert.match(
    detailComponent,
    /naturalWidth === image\.naturalHeight \* aspectRatio/u
  );
  assert.match(feedComponent, /naturalWidth === image\.naturalHeight \* 6/u);
  assert.doesNotMatch(feedComponent, /naturalHeight \* 2/u);
  assert.match(detailComponent, /bannerReady \? "relative" : "hidden"/u);
  assert.match(feedComponent, /bannerReady[\s\S]*: "hidden"/u);
  assert.match(
    feedComponent,
    /pointer-events-none absolute inset-x-0 bottom-0 h-px/u
  );
});

test("normal cleanup drains stale Sponsor upload reservations", () => {
  assert.match(cleanup, /recover_stale_sponsor_media_uploads/u);
  assert.match(cleanup, /recoveredSponsorUploads/u);
  assert.match(cleanup, /queuedFromSponsorRecovery/u);
});
