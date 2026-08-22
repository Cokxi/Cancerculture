import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(
  new URL("../../app/components/notifications/PushNotificationSettings.tsx", import.meta.url),
  "utf8"
);

test("notification preference saves are optimistic, isolated, and PATCH-only", () => {
  const mutationStart = component.indexOf("const savePreference");
  const mutationEnd = component.indexOf('if (state.status === "loading")');
  const mutations = component.slice(mutationStart, mutationEnd);

  assert.ok(mutationStart >= 0 && mutationEnd > mutationStart);
  assert.ok(
    mutations.indexOf("setState((current) => applyValue(current, enabled))")
      < mutations.indexOf("const response = await request()"),
    "the selected setting must update before its request starts"
  );
  assert.equal((mutations.match(/method: "PATCH"/gu) ?? []).length, 3);
  assert.doesNotMatch(mutations, /refresh\(\)/u);
  assert.doesNotMatch(mutations, /setBusy\(/u);

  assert.match(component, /savingSettingKeys\.has\(`in-product:\$\{category\.categoryKey\}`\)/u);
  assert.match(component, /savingSettingKeys\.has\(`cycle-preference:\$\{key\}`\)/u);
  assert.match(component, /savingSettingKeys\.has\(`push-category:\$\{category\.categoryKey\}`\)/u);
});

test("same-setting duplicates and stale outcomes cannot overwrite newer UI state", () => {
  assert.match(component, /activePreferenceRequestIds\.current\.has\(settingKey\)/u);
  assert.match(component, /activePreferenceRequestIds\.current\.set\(settingKey, requestId\)/u);
  assert.equal(
    (component.match(/activePreferenceRequestIds\.current\.get\(settingKey\) !== requestId/gu) ?? []).length,
    2
  );
  assert.match(component, /activePreferenceRequestIds\.current\.get\(settingKey\) === requestId/u);
  assert.match(component, /setState\(\(current\) => applyValue\(current, !enabled\)\)/u);
});

test("PATCH responses confirm exact outcomes and only lifecycle changes fully refresh", () => {
  assert.equal((component.match(/result\.outcome === "updated"/gu) ?? []).length, 3);
  assert.equal((component.match(/result\.enabled === enabled/gu) ?? []).length, 2);
  assert.match(component, /result\.categoryKey === categoryKey/u);
  assert.match(component, /result\.inProductEnabled === inProductEnabled/u);
  assert.equal((component.match(/It was changed back\./gu) ?? []).length, 6);

  const enableStart = component.indexOf("const enablePush");
  const disableStart = component.indexOf("const disablePush");
  const saveStart = component.indexOf("const savePreference");
  assert.match(component.slice(enableStart, disableStart), /await refresh\(\)/u);
  assert.match(component.slice(disableStart, saveStart), /await refresh\(\)/u);
  assert.match(component, /useEffect\(\(\) => \{ void refresh\(\); \}, \[refresh\]\)/u);
});
