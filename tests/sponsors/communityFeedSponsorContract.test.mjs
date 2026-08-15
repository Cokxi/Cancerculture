import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const [
  component,
  sourceResolver,
  impressionRoute,
  clickRoute,
  bannerRoute,
  consentRoute,
  tracking,
  migration,
  provider,
  fullBanner,
  layout,
  globalAccount,
  accountMenu,
] =
  await Promise.all([
    source("app/spread/CommunityFeedSponsor.tsx"),
    source("lib/feed/communityFeedSponsor.server.ts"),
    source("app/api/community-feed/sponsor/impression/[submissionId]/route.ts"),
    source("app/api/community-feed/sponsor/click/[submissionId]/route.ts"),
    source("app/api/community-feed/sponsor/banner/[submissionId]/route.ts"),
    source("app/api/sponsor/consent/route.ts"),
    source("lib/sponsors/tracking.ts"),
    source(
      "supabase/migrations/20260815000100_dual_sponsor_banner_formats_and_upload_operations.sql"
    ),
    source("app/components/sponsors/SponsorAnalyticsProvider.tsx"),
    source("app/components/SponsoredBanner.tsx"),
    source("app/layout.tsx"),
    source("app/components/auth/GlobalAccount.tsx"),
    source("app/components/auth/AccountMenu.tsx"),
  ]);

test("Feed Sponsor presentation is tied to a real visible Feed Submission and never mounted as a general ad", () => {
  assert.match(sourceResolver, /resolve_community_feed_sponsor_placement/u);
  assert.match(sourceResolver, /isSponsorFeedBannerKey/u);
  assert.match(migration, /submission\.public_visibility_status = 'visible'/u);
  assert.match(migration, /coalesce\(submission\.is_disqualified, false\) = false/u);
  assert.match(migration, /sponsorship\.is_active = true/u);
  assert.match(migration, /mod\(eligible\.placement_ordinal - 1, 7\) = 0/u);
  assert.match(component, /submissionId/u);
  assert.match(component, /image\.naturalWidth === image\.naturalHeight \* 6/u);
  assert.match(component, /Sponsored Cycle by · \{presentation\.companyName\}/u);
  assert.match(bannerRoute, /expectedDimensions: \{ width: 1800, height: 300 \}/u);
  assert.doesNotMatch(component, /setInterval|Math\.random/u);
});

test("qualified impressions require 50 percent, 1000ms, visible tab, consent, and a signed token", () => {
  assert.match(component, /SPONSOR_VIEWPORT_THRESHOLD/u);
  assert.match(component, /SPONSOR_VIEWPORT_DWELL_MS/u);
  assert.match(component, /document\.visibilityState !== "visible"/u);
  assert.match(component, /consent !== "granted"/u);
  assert.match(fullBanner, /consent === "granted"/u);
  assert.match(impressionRoute, /verifySponsorMeasurementToken/u);
  assert.match(impressionRoute, /hasSponsorMeasurementConsent/u);
  assert.match(impressionRoute, /recordSponsorEvent/u);
  assert.doesNotMatch(component, /sponsor\/track/u);
});

test("consent and identifier cookies are bounded, HttpOnly, Secure, and have no owner-secret fallback", () => {
  assert.match(consentRoute, /httpOnly: true/u);
  assert.match(consentRoute, /secure: true/u);
  assert.match(consentRoute, /sameSite: "lax"/u);
  assert.match(tracking, /30 \* 24 \* 60 \* 60/u);
  assert.match(tracking, /SPONSOR_MEASUREMENT_HMAC_SECRET/u);
  assert.doesNotMatch(tracking, /OWNER_HASH_SECRET|SPONSOR_TRACKING_SALT/u);
  assert.match(consentRoute, /SPONSOR_TRACKING_COOKIE, ""/u);
  assert.match(consentRoute, /maxAge: 0/u);
});

test("consent copy is informed, equally actionable, reversible, and hidden when measurement is unavailable", () => {
  assert.match(provider, /50% visible for one second in an\s+active tab/u);
  assert.match(provider, /pseudonymous identifier/u);
  assert.match(provider, /up\s+to 30 days/u);
  assert.match(provider, /up to 25 months/u);
  assert.match(provider, /Sponsors receive aggregate reports only/u);
  assert.match(provider, /Sponsor links work\s+without analytics/u);
  assert.match(provider, /Allow analytics/u);
  assert.match(provider, /Continue without analytics/u);
  assert.match(provider, /preferenceButtonClassName/u);
  assert.doesNotMatch(provider, /bg-orange-600/u);
  assert.doesNotMatch(component, /Optional sponsor analytics|saveConsent/u);
});

test("one global non-blocking consent bar is triggered only by an encountered valid measurable banner", () => {
  assert.match(layout, /<SponsorAnalyticsProvider>/u);
  assert.match(provider, /fixed inset-x-0 bottom-0/u);
  assert.match(provider, /pointer-events-none/u);
  assert.match(provider, /hasEncounteredSponsor/u);
  assert.match(provider, /consent === "unknown"/u);
  assert.match(component, /bannerReady/u);
  assert.match(
    component,
    /presentation\?\.sponsored[\s\S]*presentation\.measurementToken/u
  );
  assert.match(component, /registerValidSponsorPresentation/u);
  assert.match(fullBanner, /bannerReady/u);
  assert.match(fullBanner, /measurementToken/u);
  assert.match(fullBanner, /registerValidSponsorPresentation/u);
  assert.match(`${component}\n${fullBanner}`, /IntersectionObserver/u);
});

test("global Settings is anonymous-accessible and initially contains only Sponsor analytics", () => {
  assert.match(globalAccount, />\s*Settings\s*</u);
  assert.match(globalAccount, /account\.kind === "anonymous"/u);
  assert.match(globalAccount, /\{settingsButton\}[\s\S]*Login with Discord/u);
  assert.match(accountMenu, /settingsAction\.onSelect\(\)/u);
  assert.match(provider, /Global preferences/u);
  assert.match(provider, /Sponsor analytics/u);
  assert.match(provider, /Current choice/u);
  assert.match(provider, /role="dialog"/u);
  assert.match(provider, /aria-modal="true"/u);
  assert.doesNotMatch(provider, /Appearance|Background|Theme preference/u);
});

test("clicks remain functional without measurement while targets and reporting stay server-side", () => {
  assert.match(clickRoute, /resolveCommunityFeedSponsorSource/u);
  assert.match(clickRoute, /NextResponse\.redirect\(sponsor\.targetUrl\)/u);
  assert.match(clickRoute, /Referrer-Policy", "no-referrer"/u);
  assert.match(clickRoute, /hasSponsorMeasurementConsent/u);
  assert.doesNotMatch(component, /targetUrl|sponsorshipId|viewerHash|discord/u);
});
