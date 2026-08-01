import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveFlagPageView } from "../../lib/admin/flagPageView.ts";

const root = new URL("../../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("missing and invalid view parameters safely select Open flags", () => {
  assert.equal(resolveFlagPageView(undefined), "open");
  assert.equal(resolveFlagPageView(""), "open");
  assert.equal(resolveFlagPageView("open"), "open");
  assert.equal(resolveFlagPageView("closed"), "open");
  assert.equal(resolveFlagPageView("history"), "history");
});

test("server loading selects exactly one flag list", async () => {
  const page = await source("app/admin/flags/page.tsx");
  const loader = page.slice(
    page.indexOf("async function loadFlagPage"),
    page.indexOf("function ViewNavigation")
  );
  const historyBranch = loader.slice(
    loader.indexOf('if (view === "history")'),
    loader.indexOf("const activePage")
  );
  const openBranch = loader.slice(loader.indexOf("const activePage"));

  assert.doesNotMatch(loader, /Promise\.all/u);
  assert.match(historyBranch, /section: "history"/u);
  assert.doesNotMatch(historyBranch, /section: "active"/u);
  assert.match(openBranch, /section: "active"/u);
  assert.doesNotMatch(openBranch, /section: "history"/u);
});

test("Open and History render as mutually exclusive URL-backed views", async () => {
  const page = await source("app/admin/flags/page.tsx");
  const historyView = page.slice(
    page.indexOf('if (data.view === "history")'),
    page.indexOf("const visibleActiveCases")
  );
  const openView = page.slice(page.indexOf("const visibleActiveCases"));

  assert.match(historyView, /data-flag-view="history"/u);
  assert.match(historyView, /<h2>Flag history<\/h2>/u);
  assert.match(historyView, /data\.closedPage/u);
  assert.doesNotMatch(historyView, /data\.activePage/u);
  assert.match(openView, /data-flag-view="open"/u);
  assert.match(openView, /<h2>Open flags<\/h2>/u);
  assert.match(openView, /data\.activePage/u);
  assert.doesNotMatch(openView, /data\.closedPage/u);

  assert.match(page, /href="\/admin\/flags\?view=open"/u);
  assert.match(page, /href="\/admin\/flags\?view=history"/u);
  assert.match(page, /name="view" value="history"/u);
  assert.match(page, /\?view=history&q=\$\{encodeURIComponent\(query\)\}&page=/u);
  assert.match(page, /aria-current=\{view === "open" \? "page"/u);
  assert.match(page, /aria-current=\{view === "history" \? "page"/u);
});

test("review-only access cannot see or force History", async () => {
  const page = await source("app/admin/flags/page.tsx");
  const loader = page.slice(
    page.indexOf("async function loadFlagPage"),
    page.indexOf("function ViewNavigation")
  );
  const reviewLoader = loader.slice(
    loader.indexOf("if (!canView)"),
    loader.indexOf('if (view === "history")')
  );
  const reviewRender = page.slice(
    page.indexOf('if (data.kind === "review")'),
    page.indexOf('if (data.view === "history")')
  );

  assert.match(reviewLoader, /listUserFlagReviewWorklist\(\)/u);
  assert.match(reviewLoader, /return \{ kind: "review" as const, worklist \}/u);
  assert.doesNotMatch(reviewLoader, /listUserFlagCases/u);
  assert.match(reviewRender, /data-flag-view="open"/u);
  assert.match(reviewRender, /Open user flag worklist/u);
  assert.doesNotMatch(reviewRender, /ViewNavigation|Flag history/u);
});

test("Admin active-status filtering and escalated visibility remain unchanged", async () => {
  const page = await source("app/admin/flags/page.tsx");
  const openView = page.slice(page.indexOf("const visibleActiveCases"));

  assert.match(openView, /\{data\.isAdmin \? \(/u);
  assert.match(
    openView,
    /const visibleActiveCases = data\.isAdmin[\s\S]*flagCase\.status === "open"/u
  );
  assert.match(openView, /<option value="all">Open and escalated<\/option>/u);
  assert.match(openView, /<option value="open">Open only<\/option>/u);
  assert.match(openView, /<option value="escalated">Escalated only<\/option>/u);
  assert.match(openView, /visibleActiveCases\.filter\(/u);
  assert.match(openView, /flagCase\.status === activeStatus/u);
});
