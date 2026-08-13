import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const tempDirectory = await mkdtemp(
  path.join(tmpdir(), "cc-community-feed-component-"),
);
after(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

const componentSource = await readFile(
  new URL("../../app/spread/CommunityFeedClient.tsx", import.meta.url),
  "utf8",
);
const repoRoot = new URL("../../", import.meta.url);
const dependencyUrls = {
  react: new URL("node_modules/react/index.js", repoRoot).href,
  jsxRuntime: new URL("node_modules/react/jsx-runtime.js", repoRoot).href,
  nextLink: new URL("node_modules/next/link.js", repoRoot).href,
};
const transpiled = ts.transpileModule(componentSource, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  .replaceAll('"react/jsx-runtime"', JSON.stringify(dependencyUrls.jsxRuntime))
  .replaceAll('"react"', JSON.stringify(dependencyUrls.react))
  .replaceAll('"next/link"', JSON.stringify(dependencyUrls.nextLink))
  .replace(
    'import LoadMoreButton from "@/app/components/ui/LoadMoreButton";',
    "const LoadMoreButton = () => null;",
  );
const componentPath = path.join(tempDirectory, "CommunityFeedClient.mjs");
await writeFile(componentPath, transpiled, "utf8");
const { CommunityFeedCard } = await import(pathToFileURL(componentPath));

function item(overrides = {}) {
  return {
    submissionId: 17,
    cycleNumber: 8,
    imageUrl: "https://images.example/17.webp",
    mediaWidth: 1200,
    mediaHeight: 900,
    createdAt: "2026-08-13T08:00:00.000Z",
    finalizedAt: "2026-08-13T09:00:00.000Z",
    finalVoteCount: 5,
    rankInCycle: 2,
    ...overrides,
  };
}

test("Feed card renders stable intrinsic media and article semantics without a misleading pseudo-detail link", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CommunityFeedCard, {
      feed: "all",
      item: item(),
      position: 1,
    }),
  );

  assert.match(markup, /<article[^>]*aria-labelledby=/u);
  assert.match(markup, /data-feed-submission-id="17"/u);
  assert.match(markup, /style="aspect-ratio:1200 \/ 900"/u);
  assert.match(markup, /width="1200"/u);
  assert.match(markup, /height="900"/u);
  assert.match(markup, /loading="eager"/u);
  assert.match(markup, /fetchPriority="high"/u);
  assert.match(markup, /Rank #2/u);
  assert.match(markup, /5 votes/u);
  assert.doesNotMatch(markup, /Open link|Open submission|submission=17/u);
  assert.match(markup, /<time/u);
});

test("legacy or unavailable media keeps a stable placeholder without leaking hidden detail", () => {
  const markup = renderToStaticMarkup(
    React.createElement(CommunityFeedCard, {
      feed: "trash",
      item: item({
        submissionId: 22,
        imageUrl: null,
        mediaWidth: null,
        mediaHeight: null,
      }),
      position: 4,
    }),
  );

  assert.match(markup, /style="aspect-ratio:4 \/ 3"/u);
  assert.match(markup, /role="img"/u);
  assert.match(markup, /Submission image unavailable/u);
  assert.doesNotMatch(
    markup,
    /discord|moderation|report|sponsor|observation|wallet|actor/iu,
  );
});
