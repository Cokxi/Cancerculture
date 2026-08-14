import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const [component, sourceResolver, impressionRoute, clickRoute, consentRoute, tracking] =
  await Promise.all([
    source("app/spread/CommunityFeedSponsor.tsx"),
    source("lib/feed/communityFeedSponsor.server.ts"),
    source("app/api/community-feed/sponsor/impression/[submissionId]/route.ts"),
    source("app/api/community-feed/sponsor/click/[submissionId]/route.ts"),
    source("app/api/sponsor/consent/route.ts"),
    source("lib/sponsors/tracking.ts"),
  ]);

test("Feed Sponsor presentation is tied to a real visible Feed Submission and never mounted as a general ad", () => {
  assert.match(sourceResolver, /resolveCommunityFeedCycleSource/u);
  assert.match(sourceResolver, /\.eq\("cycle_id", cycle\.cycleId\)/u);
  assert.match(sourceResolver, /feed === "live"[\s\S]*\.eq\("is_active", true\)/u);
  assert.match(component, /submissionId/u);
  assert.doesNotMatch(component, /setInterval|Math\.random/u);
});

test("qualified impressions require 50 percent, 1000ms, visible tab, consent, and a signed token", () => {
  assert.match(component, /SPONSOR_VIEWPORT_THRESHOLD/u);
  assert.match(component, /SPONSOR_VIEWPORT_DWELL_MS/u);
  assert.match(component, /document\.visibilityState !== "visible"/u);
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
  assert.match(component, /presentation\.measurementToken && consent === "unknown"/u);
  assert.match(component, /50% visible for one second in an active tab/u);
  assert.match(component, /pseudonymous\s+identifier/u);
  assert.match(component, /up to 30 days/u);
  assert.match(component, /up to 25 months/u);
  assert.match(component, /Sponsors receive aggregate\s+reports only/u);
  assert.match(component, /Sponsor links work without analytics/u);
  assert.match(component, /change\s+your choice here at any time/u);
  assert.match(component, /Continue without analytics/u);
  assert.match(component, /Turn off analytics/u);
  assert.match(component, /SPONSOR_CONSENT_CHANGED_EVENT/u);
  assert.doesNotMatch(component, /bg-orange-600/u);
});

test("clicks remain functional without measurement while targets and reporting stay server-side", () => {
  assert.match(clickRoute, /resolveCommunityFeedSponsorSource/u);
  assert.match(clickRoute, /NextResponse\.redirect\(sponsor\.targetUrl\)/u);
  assert.match(clickRoute, /Referrer-Policy", "no-referrer"/u);
  assert.match(clickRoute, /hasSponsorMeasurementConsent/u);
  assert.doesNotMatch(component, /targetUrl|sponsorshipId|viewerHash|discord/u);
});
