import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("the real FAQ Admin page, mutation, and navigation share faq.manage", async () => {
  const [page, actions, navigation] = await Promise.all([
    readRepoFile("app/admin/content/faq/page.tsx"),
    readRepoFile("app/admin/content/faq/actions.ts"),
    readRepoFile("lib/admin/teamAreaNavigation.ts"),
  ]);

  assert.match(
    page,
    /requireTeamCapabilityPage\("faq\.manage", "\/admin\/content\/faq"\)/u
  );
  assert.equal(
    actions.match(/requireDynamicTeamCapability\("faq\.manage"\)/gu)?.length,
    1
  );
  assert.match(navigation, /capability: "faq\.manage"/u);
  assert.match(navigation, /href: "\/admin\/content\/faq"/u);
  assert.match(navigation, /requirement: faqManagement/u);
  assert.match(navigation, /implemented: true/u);
});

test("FAQ has one complete Save & Publish action and no server draft", async () => {
  const [actions, editor, manager] = await Promise.all([
    readRepoFile("app/admin/content/faq/actions.ts"),
    readRepoFile("app/admin/content/faq/FaqEditor.tsx"),
    readRepoFile("lib/content/faq/manage.server.ts"),
  ]);

  assert.match(actions, /parseFaqContentJson/u);
  assert.match(actions, /saveAndPublishFaqContent/u);
  assert.match(actions, /updateTag\(FAQ_CONTENT_CACHE_TAG\)/u);
  assert.match(actions, /revalidatePath\("\/faq"\)/u);
  assert.match(actions, /FAQ_CONTENT_NO_CHANGES/u);
  assert.match(actions, /There are no FAQ changes to save and publish/u);
  assert.equal(actions.match(/export async function/gu)?.length, 1);
  assert.match(editor, /Save &amp; Publish/u);
  assert.match(editor, /Local Editor Preview/u);
  assert.match(editor, /does not save a server draft/u);
  assert.match(editor, /useActionState/u);
  assert.equal(editor.match(/aria-live="polite"/gu)?.length, 1);
  assert.match(manager, /operation: "save_publish"/u);
  assert.doesNotMatch(manager, /save_draft|materialChange|rulesVersion/u);
});

test("the editor supports bounded ordered sections and exact safe preview", async () => {
  const [editor, renderer] = await Promise.all([
    readRepoFile("app/admin/content/faq/FaqEditor.tsx"),
    readRepoFile("app/components/content/FaqDocumentView.tsx"),
  ]);

  assert.match(editor, /Add Section/u);
  assert.match(editor, /Move Up/u);
  assert.match(editor, /Move Down/u);
  assert.match(editor, /Remove Section/u);
  assert.match(editor, /FAQ_CONTENT_LIMITS/u);
  assert.match(editor, /<FaqDocumentView document=\{previewDocument\}/u);
  assert.match(editor, /normalizedEditorDocument/u);
  assert.doesNotMatch(renderer, /dangerouslySetInnerHTML/u);
  assert.match(renderer, /url\.protocol !== "https:"/u);
  assert.match(renderer, /url\.username \|\| url\.password/u);
  assert.match(renderer, /rel="noopener noreferrer"/u);
  assert.match(renderer, /document\.sections\.map/u);
  assert.match(renderer, /section\.paragraphs\.map/u);
  assert.match(renderer, /section\.bullets\.map/u);
});

test("the public FAQ reads only the published validated cached revision", async () => {
  const [page, data] = await Promise.all([
    readRepoFile("app/faq/page.tsx"),
    readRepoFile("lib/content/faq/data.server.ts"),
  ]);

  assert.match(page, /getPublishedFaqContent/u);
  assert.match(page, /published\.content/u);
  assert.match(data, /\.from\("content_documents"\)/u);
  assert.match(data, /published_revision_id/u);
  assert.match(data, /\.eq\("document_key", "faq"\)/u);
  assert.match(data, /validateFaqContent\(row\.content\)/u);
  assert.match(data, /unstable_cache/u);
  assert.match(data, /FAQ_CONTENT_CACHE_TAG/u);
  assert.doesNotMatch(page, /app\/content\/faq|faqSections/u);
});
