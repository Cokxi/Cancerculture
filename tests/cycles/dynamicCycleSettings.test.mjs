import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SUBMISSIONS_PER_USER,
  DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS,
  isValidSubmissionsPerUser,
  isValidUploadSuccessCooldownSeconds,
} from "../../lib/cycles/submissionSettings.ts";

test("normal cycle defaults are two submissions and 120 seconds", () => {
  assert.equal(DEFAULT_SUBMISSIONS_PER_USER, 2);
  assert.equal(DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS, 120);
});

test("submission quota accepts only integer values from 1 through 20", () => {
  assert.equal(isValidSubmissionsPerUser(1), true);
  assert.equal(isValidSubmissionsPerUser(20), true);
  assert.equal(isValidSubmissionsPerUser(0), false);
  assert.equal(isValidSubmissionsPerUser(21), false);
  assert.equal(isValidSubmissionsPerUser(2.5), false);
});

test("successful-upload cooldown accepts only integer values from 30 through 300", () => {
  assert.equal(isValidUploadSuccessCooldownSeconds(30), true);
  assert.equal(isValidUploadSuccessCooldownSeconds(300), true);
  assert.equal(isValidUploadSuccessCooldownSeconds(29), false);
  assert.equal(isValidUploadSuccessCooldownSeconds(301), false);
  assert.equal(isValidUploadSuccessCooldownSeconds(60.5), false);
});

test("Cycle start route uses the normal defaults when settings are omitted", async () => {
  const route = await readFile(
    new URL("../../app/api/admin/cycles/start/route.ts", import.meta.url),
    "utf8"
  );

  assert.match(route, /DEFAULT_SUBMISSIONS_PER_USER/);
  assert.match(route, /DEFAULT_UPLOAD_SUCCESS_COOLDOWN_SECONDS/);
  assert.match(route, /body\?\.submissionsPerUser === undefined/);
  assert.match(route, /body\?\.uploadSuccessCooldownSeconds === undefined/);
});

test("cycle management fails closed on schema errors without hiding existing controls", async () => {
  const [page, controls, hudControls] = await Promise.all([
    readFile(new URL("../../app/admin/cycles/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../../app/admin/cycles/CycleControls.tsx", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../app/admin/cycles/CycleHudControls.tsx", import.meta.url),
      "utf8"
    ),
  ]);

  assert.match(page, /currentCycleResult\.error/);
  assert.match(page, /Cycle management schema or state is unavailable/);
  assert.match(controls, /Reset Cycle/);
  assert.match(hudControls, /END SUBMISSIONS \+ START VOTING/);
  assert.match(hudControls, /START VOTING PHASE/);
  assert.match(hudControls, /timer/iu);
});

test("home HUD always renders both configured per-user limits", async () => {
  const hud = await readFile(
    new URL("../../app/components/CycleHud.tsx", import.meta.url),
    "utf8"
  );

  assert.match(hud, /votes_per_user,/);
  assert.match(hud, /submissions_per_user,/);
  assert.match(hud, /Submissions per user:/);
  assert.match(hud, /Votes per user:/);
  assert.doesNotMatch(hud, /votes_per_user !== 2/);
  assert.match(hud, /relevantResult\.error/);
});

test("dynamic public copy uses fresh cache generations", async () => {
  const [homepageInfo, rules, faq] = await Promise.all([
    readFile(
      new URL("../../lib/homepageInfoBlocks/data.server.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../lib/content/rules/data.server.ts", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../../lib/content/faq/data.server.ts", import.meta.url),
      "utf8"
    ),
  ]);

  assert.match(homepageInfo, /homepage-info-blocks-active-v2/);
  assert.match(rules, /published-rules-content-v2/);
  assert.match(faq, /published-faq-content-v2/);
  assert.doesNotMatch(
    `${homepageInfo}\n${rules}\n${faq}`,
    /(?:homepage-info-blocks-active|published-(?:rules|faq)-content)-v1/
  );
});
