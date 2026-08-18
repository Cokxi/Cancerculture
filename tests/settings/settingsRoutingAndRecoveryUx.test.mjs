import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const [
  settingsLayout,
  settingsNavigation,
  settingsPage,
  securityPage,
  sponsorPage,
  sponsorSettings,
  provider,
  twoFactor,
  teamPage,
  teamForm,
  accountMenu,
  anonymousMenu,
] = await Promise.all([
  source("app/settings/layout.tsx"),
  source("app/components/settings/SettingsNavigation.tsx"),
  source("app/settings/page.tsx"),
  source("app/settings/security/page.tsx"),
  source("app/settings/sponsor-analytics/page.tsx"),
  source("app/components/sponsors/SponsorAnalyticsSettings.tsx"),
  source("app/components/sponsors/SponsorAnalyticsProvider.tsx"),
  source("app/components/auth/TwoFactorSettings.tsx"),
  source("app/team-access/page.tsx"),
  source("app/team-access/TeamAccessForm.tsx"),
  source("app/components/auth/AccountMenu.tsx"),
  source("app/components/auth/AnonymousAccountMenu.tsx"),
]);

test("Settings and Security are real direct-link routes with normal page scrolling", async () => {
  assert.match(settingsLayout, /<SettingsNavigation/u);
  assert.match(settingsNavigation, /href: "\/settings"/u);
  assert.match(settingsNavigation, /href: "\/settings\/security"/u);
  assert.match(settingsNavigation, /href: "\/settings\/notifications"/u);
  assert.match(settingsNavigation, /href: "\/settings\/sponsor-analytics"/u);
  assert.match(settingsNavigation, /aria-current=\{pathname === item\.href \? "page"/u);
  assert.match(settingsPage, /href="\/settings\/security"/u);
  assert.match(settingsPage, /href="\/settings\/notifications"/u);
  const notificationSettings = await source("app/components/notifications/PushNotificationSettings.tsx");
  assert.match(notificationSettings, /role="switch"/u);
  assert.match(notificationSettings, /aria-checked=\{checked\}/u);
  assert.match(notificationSettings, /category\.description/u);
  assert.match(securityPage, /<TwoFactorSettings/u);
  assert.match(accountMenu, /href="\/settings"/u);
  assert.match(anonymousMenu, /href="\/settings"/u);
  assert.doesNotMatch(`${settingsLayout}\n${settingsPage}\n${securityPage}`, /BaseOverlay|max-h-\[55vh\]|overflow-y-auto/u);
  assert.doesNotMatch(provider, /settingsOpen|settingsView|BaseOverlay|TwoFactorSettings/u);
});

test("Settings reuses the site Home control and established heading style", () => {
  assert.match(settingsLayout, /import BackButton from "@\/app\/components\/ui\/BackButton"/u);
  assert.match(settingsLayout, /<BackButton href="\/" label="Home" \/>/u);
  assert.doesNotMatch(settingsLayout, /← Home|import Link from "next\/link"/u);

  for (const page of [settingsLayout, settingsNavigation, settingsPage, securityPage, sponsorPage, sponsorSettings]) {
    assert.match(page, /font-\['Permanent_Marker'\]/u);
    assert.match(page, /text-\[var\(--orange-main\)\]/u);
  }

  assert.match(twoFactor, /id="manage-two-factor-title"[^>]+font-\['Permanent_Marker'\][^>]+text-\[var\(--orange-main\)\]/u);
  assert.match(twoFactor, /id="disable-two-factor-title"[^>]+font-\['Permanent_Marker'\][^>]+text-red-100/u);
});

test("anonymous Settings keeps privacy controls public while Security asks for Discord login", () => {
  assert.doesNotMatch(`${settingsPage}\n${sponsorPage}`, /requireSession|redirect\("\/403"\)/u);
  assert.match(sponsorPage, /available to anonymous and signed-in/u);
  assert.match(sponsorSettings, /This setting is available without signing in/u);
  assert.match(sponsorSettings, /saveConsent\("granted"\)/u);
  assert.match(sponsorSettings, /saveConsent\("denied"\)/u);
  assert.match(twoFactor, /loadErrorCode === "NOT_AUTHENTICATED"/u);
  assert.match(twoFactor, /href="\/api\/auth\/discord\/login\?state=\/settings\/security"/u);
});

test("lost-authenticator choices distinguish recovery code and verified backup email", () => {
  assert.match(twoFactor, /Lost your authenticator\?/u);
  assert.match(twoFactor, /Use a recovery code/u);
  assert.match(twoFactor, /Use verified backup email/u);
  assert.match(twoFactor, /beginEnrollment\("email_recovery"\)/u);
  assert.match(twoFactor, /Start new authenticator setup/u);
});

test("Team gate links to Security but remains current-TOTP only", () => {
  assert.match(teamPage, /href="\/settings\/security"/u);
  assert.doesNotMatch(teamPage, /href="\/account"/u);
  assert.match(teamPage, /Recovery codes are not accepted at this/u);
  assert.match(teamForm, /Current authenticator code/u);
  assert.match(teamForm, /inputMode="numeric"/u);
  assert.match(teamForm, /length !== 6/u);
  assert.doesNotMatch(teamForm, /recovery code|email recovery/iu);
});

test("Security controls keep focus, status, labels, and small-screen-safe layout contracts", () => {
  assert.match(twoFactor, /actionHeadingRef\.current\?\.focus\(\)/u);
  assert.match(twoFactor, /emailRecoveryHeadingRef\.current\?\.focus\(\)/u);
  assert.match(twoFactor, /role="alert"/u);
  assert.match(twoFactor, /role="status"/u);
  assert.match(twoFactor, /aria-busy/u);
  assert.match(twoFactor, /htmlFor="two-factor-step-up-code"/u);
  assert.match(twoFactor, /htmlFor="email-recovery-code"/u);
  assert.match(twoFactor, /flex flex-col gap-2 sm:flex-row/u);
  assert.match(twoFactor, /md:grid-cols-2/u);
});
