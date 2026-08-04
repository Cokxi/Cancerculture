import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("the real Admin page and both mutations share the exact Rules capability", async () => {
  const [page, actions, navigation] = await Promise.all([
    readRepoFile("app/admin/content/rules/page.tsx"),
    readRepoFile("app/admin/content/rules/actions.ts"),
    readRepoFile("lib/admin/teamAreaNavigation.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\("rules\.manage", "\/admin\/content\/rules"\)/u
  );
  assert.equal(
    actions.match(/requireDynamicTeamCapability\("rules\.manage"\)/gu)
      ?.length,
    2
  );
  assert.match(navigation, /capability: "rules\.manage"/u);
  assert.match(navigation, /href: "\/admin\/content\/rules"/u);
  assert.match(navigation, /requirement: rulesManagement/u);
  assert.match(navigation, /implemented: true/u);
});

test("draft save validates structured content and publish requires a material decision", async () => {
  const [actions, editor] = await Promise.all([
    readRepoFile("app/admin/content/rules/actions.ts"),
    readRepoFile("app/admin/content/rules/RulesEditor.tsx"),
  ]);

  assert.match(actions, /parseRulesContentJson/u);
  assert.match(actions, /operation: "save_draft"/u);
  assert.match(actions, /operation: "publish"/u);
  assert.match(actions, /materialChangeValue !== "true"/u);
  assert.match(actions, /updateTag\(RULES_CONTENT_CACHE_TAG\)/u);
  assert.match(actions, /revalidatePath\("\/rules"\)/u);
  assert.match(editor, /Save Versioned Draft/u);
  assert.match(editor, /Publish Saved Draft/u);
  assert.match(editor, /useActionState/u);
  assert.equal(editor.match(/aria-live="polite"/gu)?.length, 2);
  assert.match(editor, /name="material_change"/u);
  assert.match(editor, /Adding or removing a section always overrides/u);
});

test("the editor supports ordered bounded sections and a shared safe preview", async () => {
  const [editor, renderer] = await Promise.all([
    readRepoFile("app/admin/content/rules/RulesEditor.tsx"),
    readRepoFile("app/components/content/RulesDocumentView.tsx"),
  ]);

  assert.match(editor, /Add Section/u);
  assert.match(editor, /Move Up/u);
  assert.match(editor, /Move Down/u);
  assert.match(editor, /Remove Section/u);
  assert.match(editor, /RULES_CONTENT_LIMITS/u);
  assert.match(editor, /<RulesDocumentView document=\{previewDocument\}/u);
  assert.match(editor, /normalizedEditorDocument/u);
  assert.match(editor, /paragraphEditorLines/u);
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML/u);
  assert.match(renderer, /document\.sections\.map/u);
  assert.match(renderer, /section\.paragraphs\.map/u);
  assert.match(renderer, /section\.bullets\.map/u);
});

test("the public Rules page reads only the published validated revision", async () => {
  const [page, data] = await Promise.all([
    readRepoFile("app/rules/page.tsx"),
    readRepoFile("lib/content/rules/data.server.ts"),
  ]);

  assert.match(page, /getPublishedRulesContent/u);
  assert.match(page, /published\.revision\.content/u);
  assert.match(data, /\.from\("content_documents"\)/u);
  assert.match(data, /published_revision_id/u);
  assert.match(data, /\.select\("current_version, updated_at"\)/u);
  assert.match(data, /rulesUpdatedAt: rulesMeta\.updatedAt/u);
  assert.match(data, /validateRulesContent\(row\.content\)/u);
  assert.match(data, /unstable_cache/u);
  assert.match(data, /RULES_CONTENT_CACHE_TAG/u);
  assert.match(page, /rulesUpdatedAt=\{published\.rulesUpdatedAt\}/u);
  assert.doesNotMatch(page, /rulesVersion=/u);
  assert.doesNotMatch(page, /standardRulesSections/u);
});

test("the public footer shows the canonical material Rules update time", async () => {
  const [renderer, formatter] = await Promise.all([
    readRepoFile("app/components/content/RulesDocumentView.tsx"),
    readRepoFile("lib/content/rules/format.ts"),
  ]);

  assert.match(renderer, /Rules last updated/u);
  assert.match(renderer, /<time dateTime=\{rulesUpdatedAt\}>/u);
  assert.match(renderer, /formatRulesUpdatedAt\(rulesUpdatedAt\)/u);
  assert.doesNotMatch(renderer, /Rules version/u);
  assert.match(formatter, /timeZone: "UTC"/u);
  assert.match(formatter, /timeZoneName: "short"/u);
});
