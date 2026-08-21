import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeSafePublicHttpsUrl } from "../../lib/organizations/urlValidation.ts";

const repoRoot = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, repoRoot), "utf8");
const migration = await source(
  "supabase/migrations/20260821000200_dynamic_organization_catalog.sql"
);

test("the migration is one additive fail-closed cutover with the exact ten-entry manifest", () => {
  assert.match(migration, /DYNAMIC_ORGANIZATION_CATALOG_BASELINE_MISMATCH/u);
  assert.match(migration, /DYNAMIC_ORGANIZATION_CATALOG_POSTFLIGHT_MISMATCH/u);
  assert.match(migration, /\(select count\(\*\) from public\.donation_organizations\) <> 10/u);
  for (const key of [
    "animal-haven",
    "animal-rescue-corps",
    "doctors-without-borders-usa",
    "feeding-pets-of-the-homeless",
    "institute-for-justice",
    "no-kid-hungry",
    "save-the-children",
    "sea-shepherd-conservation-society",
    "st-jude-childrens-research-hospital",
    "young-lives-vs-cancer",
  ]) {
    assert.equal(migration.match(new RegExp(`\\('${key}',`, "gu"))?.length, 1);
  }
  assert.doesNotMatch(migration, /drop table|truncate table|delete from public\./iu);
});

test("capability, ACL, expected-version, replay, and append-only event contracts are explicit", () => {
  assert.match(migration, /donation_organizations\.manage/u);
  assert.match(migration, /DONATION_ORGANIZATION_STATE_CONFLICT/u);
  assert.match(migration, /DONATION_ORGANIZATION_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /ORGANIZATION_REFERENCE_STATE_CONFLICT/u);
  assert.match(migration, /ORGANIZATION_REFERENCE_IDEMPOTENCY_CONFLICT/u);
  assert.match(migration, /create table public\.donation_organization_events/u);
  assert.match(migration, /create table public\.submission_organization_reference_events/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /from public, anon, authenticated, discord_bot, service_role/u);
  assert.match(migration, /where capability_key = 'donation_organizations\.manage'/u);
});

test("historical catalog and Other references remain separate from their effective review state", () => {
  assert.match(migration, /original_name text not null/u);
  assert.match(migration, /original_website_url text/u);
  assert.match(migration, /effective_version bigint not null/u);
  assert.match(migration, /effective_state in \('verified', 'pending', 'quarantined'\)/u);
  assert.match(migration, /effective_state in \('pending', 'quarantined'\) and effective_website_url is null/u);
  assert.match(migration, /source_type = 'legacy'[\s\S]*original_website_url is null/u);
  assert.doesNotMatch(migration, /update public\.submission_private_data/u);
});

test("catalog binding happens after reservation and before an R2 status may advance", async () => {
  const [route, saga] = await Promise.all([
    source("app/api/upload/route.ts"),
    source("lib/upload/submissionUploadSaga.ts"),
  ]);
  assert.ok(route.indexOf("reserveSubmissionUpload({") < route.indexOf("bindSubmissionUploadOrganization({"));
  assert.ok(route.indexOf("bindSubmissionUploadOrganization({") < route.indexOf("new PutObjectCommand"));
  assert.match(saga, /bind_submission_upload_organization/u);
  assert.match(migration, /SUBMISSION_ORGANIZATION_BINDING_REQUIRED/u);
});

test("Upload and overlay consume the shared catalog and contain no organization-name manifest", async () => {
  const [uploadPage, desktopUpload, overlay, content] = await Promise.all([
    source("app/upload/page.tsx"),
    source("app/components/upload/DesktopUpload.tsx"),
    source("app/components/overlay/CharitiesOverlay.tsx"),
    source("app/components/charities/CharitiesContent.tsx"),
  ]);
  assert.match(uploadPage, /getDonationOrganizationCatalog/u);
  assert.match(desktopUpload, /donationOrganizations/u);
  assert.match(overlay, /organizations=\{organizations\}/u);
  assert.match(content, /organizations\.map/u);
  assert.doesNotMatch(desktopUpload, /CHARITY_OPTIONS|Doctors Without Borders|Young Lives vs Cancer/u);
  assert.doesNotMatch(content, /Animal Haven|No Kid Hungry|St\. Jude/u);
});

test("public HTTPS validation rejects credentials, local, private, link-local, and internal targets", () => {
  assert.equal(normalizeSafePublicHttpsUrl("https://Example.org/path#fragment"), "https://example.org/path");
  for (const value of [
    "http://example.org",
    "https://name:secret@example.org",
    "https://localhost",
    "https://service.local",
    "https://service.internal",
    "https://10.0.0.1",
    "https://172.16.1.1",
    "https://192.168.1.1",
    "https://169.254.1.1",
    "https://224.0.0.1",
    "https://[::1]",
  ]) {
    assert.throws(() => normalizeSafePublicHttpsUrl(value));
  }
});

test("new catalog controls retain responsive layout and native accessible names", async () => {
  const [desktopUpload, content, managementPage] = await Promise.all([
    source("app/components/upload/DesktopUpload.tsx"),
    source("app/components/charities/CharitiesContent.tsx"),
    source("app/admin/content/organizations/page.tsx"),
  ]);
  assert.match(desktopUpload, /htmlFor="donation-organization"/u);
  assert.match(desktopUpload, /id="donation-organization"/u);
  assert.match(desktopUpload, /aria-describedby=\{[\s\S]*donation-organization-status/u);
  assert.match(desktopUpload, /htmlFor="other-organization-name"/u);
  assert.match(desktopUpload, /htmlFor="other-organization-url"/u);
  assert.match(desktopUpload, /id="other-organization-privacy"/u);
  assert.match(content, /<article/u);
  assert.match(content, /<h2/u);
  assert.match(content, /className="leading-7 text-white"/u);
  assert.match(content, /alt=\{`\$\{organization\.displayName\} organization logo`\}/u);
  assert.match(content, /grid gap-6 sm:grid-cols-/u);
  assert.match(content, /flex flex-wrap/u);
  assert.match(managementPage, /md:grid-cols-2/u);
  assert.match(managementPage, /flex flex-wrap/u);
});
