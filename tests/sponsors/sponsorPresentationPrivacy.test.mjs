import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.SPONSOR_MEASUREMENT_HMAC_SECRET = "p".repeat(64);
const {
  createSponsorPresentationGrant,
  verifySponsorPresentationGrant,
} = await import("../../lib/sponsors/presentationToken.server.ts");

test("legacy Sponsor presentation grants bind opaque tokens to one surface", () => {
  const nowMs = Date.parse("2026-08-15T10:00:00.000Z");
  const grant = createSponsorPresentationGrant({
    sponsorshipId: 17,
    surface: "history_modal",
    nowMs,
  });
  assert.ok(grant?.token);
  assert.equal(
    grant.token
      .split(".")
      .some((part) =>
        Buffer.from(part, "base64url").toString("utf8").includes("sponsorshipId")
      ),
    false
  );
  assert.equal(
    verifySponsorPresentationGrant({
      token: grant.token,
      surface: "history_modal",
      nowMs,
    })?.sponsorshipId,
    17
  );
  assert.equal(
    verifySponsorPresentationGrant({
      token: grant.token,
      surface: "fame_modal",
      nowMs,
    }),
    null
  );
  const tokenParts = grant.token.split(".");
  const tag = tokenParts.at(-1) ?? "";
  tokenParts[tokenParts.length - 1] = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`;
  const tampered = tokenParts.join(".");
  assert.equal(
    verifySponsorPresentationGrant({
      token: tampered,
      surface: "history_modal",
      nowMs,
    }),
    null
  );

  const detailGrant = createSponsorPresentationGrant({
    sponsorshipId: 17,
    surface: "spread_detail",
    nowMs,
  });
  assert.equal(
    verifySponsorPresentationGrant({
      token: detailGrant?.token ?? "",
      surface: "spread_detail",
      nowMs,
    })?.surface,
    "spread_detail"
  );
});

test("browser-facing Sponsor DTOs and components contain no raw key, target, or internal id", async () => {
  const [
    cycleSource,
    reportPage,
    component,
    feedComponent,
    exportRoute,
    bannerRoute,
    spreadDetailPage,
  ] =
    await Promise.all([
      readFile(
        new URL("../../lib/cycles/sponsoredCycle.ts", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../app/admin/logs/sponsors/page.tsx", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../app/components/SponsoredBanner.tsx", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../app/spread/CommunityFeedSponsor.tsx", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL(
          "../../app/api/admin/sponsors/cycle/[cycleNumber]/export/route.ts",
          import.meta.url
        ),
        "utf8"
      ),
      readFile(
        new URL("../../app/api/sponsor/banner/route.ts", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../app/spread/[submissionId]/page.tsx", import.meta.url),
        "utf8"
      ),
    ]);
  const publicType = cycleSource.slice(
    cycleSource.indexOf("export type SponsoredCycleMeta"),
    cycleSource.indexOf("export type CycleSponsorshipSource")
  );
  assert.doesNotMatch(
    publicType,
    /sponsorshipId|sponsorLink|R2Key|targetUrl|bucket/iu
  );
  assert.doesNotMatch(component, /sponsorshipId|sponsorLink|R2Key|targetUrl/iu);
  assert.doesNotMatch(
    feedComponent,
    /sponsorshipId|sponsorLink|R2Key|targetUrl|viewerHash|discord/iu
  );
  assert.doesNotMatch(exportRoute, /banner_r2_key|feed_banner_r2_key/u);
  assert.doesNotMatch(
    exportRoute,
    /sponsorship:\s*\{[\s\S]*?\b(?:id|cycle_id):/u
  );
  assert.doesNotMatch(reportPage, /Cycle internal ID/u);
  assert.doesNotMatch(
    reportPage,
    /api\/admin\/sponsors\/\$\{sponsorship\.id\}/u
  );
  assert.match(reportPage, /api\/admin\/sponsors\/cycle\/\$\{cycleNumber\}/u);
  assert.match(cycleSource, /surface === "spread_detail" && !source\.feedBannerR2Key/u);
  assert.match(bannerRoute, /grant\.surface === "spread_detail"/u);
  assert.match(bannerRoute, /storageKey: source\.feedBannerR2Key/u);
  assert.match(bannerRoute, /expectedDimensions: \{ width: 1800, height: 300 \}/u);
  assert.match(spreadDetailPage, /format="feed"/u);
  assert.match(component, /format === "feed" \? "aspect-\[6\/1\]"/u);
});
