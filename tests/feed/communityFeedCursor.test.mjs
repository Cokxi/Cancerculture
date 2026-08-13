import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

const repoRoot = path.resolve(
  new URL("../..", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
);
const tempDirectory = await mkdtemp(
  path.join(tmpdir(), "cc-community-feed-cursor-"),
);

after(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

function transpile(sourceText) {
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const [paginationSource, cursorSource, feedSource] = await Promise.all([
  readFile(
    path.join(repoRoot, "lib/pagination/publicPagination.ts"),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "lib/pagination/publicPaginationCursor.ts"),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "lib/feed/communityFeed.ts"),
    "utf8",
  ),
]);

await Promise.all([
  writeFile(
    path.join(tempDirectory, "publicPagination.mjs"),
    transpile(paginationSource),
    "utf8",
  ),
  writeFile(
    path.join(tempDirectory, "publicPaginationCursor.mjs"),
    transpile(cursorSource).replace(
      '"./publicPagination"',
      '"./publicPagination.mjs"',
    ),
    "utf8",
  ),
  writeFile(
    path.join(tempDirectory, "communityFeed.mjs"),
    transpile(feedSource),
    "utf8",
  ),
]);

const pagination = await import(
  pathToFileURL(path.join(tempDirectory, "publicPagination.mjs"))
);
const cursorCodec = await import(
  pathToFileURL(path.join(tempDirectory, "publicPaginationCursor.mjs"))
);
const feed = await import(
  pathToFileURL(path.join(tempDirectory, "communityFeed.mjs"))
);
const secret = "f".repeat(32);

function signedBody(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

test("Live cursors bind the full keyset tuple to Cycle and reset context", () => {
  const payload = {
    version: pagination.PUBLIC_PAGINATION_CURSOR_VERSION,
    scope: pagination.PUBLIC_PAGINATION_SCOPES.feedLive,
    context: { feed: "live", cycleId: 72, resetCount: 4 },
    values: {
      createdAt: "2026-08-12T10:15:30.000Z",
      submissionId: 901,
    },
  };
  const cursor = cursorCodec.encodePublicPaginationCursor(payload, secret);

  assert.deepEqual(
    cursorCodec.decodePublicPaginationCursor(
      cursor,
      pagination.PUBLIC_PAGINATION_SCOPES.feedLive,
      { feed: "live", cycleId: 72, resetCount: 4 },
      secret,
    ),
    payload,
  );
  assert.deepEqual(
    cursorCodec.decodePublicPaginationCursorForScope(
      cursor,
      pagination.PUBLIC_PAGINATION_SCOPES.feedLive,
      secret,
    ),
    payload,
  );

  for (const context of [
    { feed: "live", cycleId: 73, resetCount: 4 },
    { feed: "live", cycleId: 72, resetCount: 5 },
  ]) {
    assert.throws(
      () =>
        cursorCodec.decodePublicPaginationCursor(
          cursor,
          pagination.PUBLIC_PAGINATION_SCOPES.feedLive,
          context,
          secret,
        ),
      { name: "PublicPaginationCursorError" },
    );
  }
});

test("each finalized Feed has its own scope, classification context, and full sort tuple", () => {
  const cases = [
    ["top10", pagination.PUBLIC_PAGINATION_SCOPES.feedTop10],
    ["all", pagination.PUBLIC_PAGINATION_SCOPES.feedAll],
    ["trash", pagination.PUBLIC_PAGINATION_SCOPES.feedTrash],
  ];

  for (const [feedKind, scope] of cases) {
    const payload = {
      version: pagination.PUBLIC_PAGINATION_CURSOR_VERSION,
      scope,
      context: {
        feed: feedKind,
        classificationVersion:
          feed.COMMUNITY_FEED_CLASSIFICATION_VERSION,
      },
      values: {
        finalizedAt: "2026-08-11T20:00:00.000Z",
        cycleId: 71,
        rankInCycle: 10,
        submissionId: 812,
      },
    };
    const cursor = cursorCodec.encodePublicPaginationCursor(payload, secret);

    assert.deepEqual(
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        scope,
        payload.context,
        secret,
      ),
      payload,
    );
  }
});

test("Feed scopes cannot be replayed across feeds or classification versions", () => {
  const payload = {
    version: 1,
    scope: pagination.PUBLIC_PAGINATION_SCOPES.feedAll,
    context: { feed: "all", classificationVersion: 1 },
    values: {
      finalizedAt: "2026-08-11T20:00:00.000Z",
      cycleId: 71,
      rankInCycle: 3,
      submissionId: 810,
    },
  };
  const cursor = cursorCodec.encodePublicPaginationCursor(payload, secret);

  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.feedTrash,
        { feed: "trash", classificationVersion: 1 },
        secret,
      ),
    { name: "PublicPaginationCursorError" },
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursorForScope(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.feedTrash,
        secret,
      ),
    { name: "PublicPaginationCursorError" },
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.feedAll,
        { feed: "all", classificationVersion: 2 },
        secret,
      ),
    { name: "PublicPaginationCursorError" },
  );
});

test("tampered or structurally incomplete Feed cursors fail closed", () => {
  const payload = {
    version: 1,
    scope: pagination.PUBLIC_PAGINATION_SCOPES.feedTop10,
    context: { feed: "top10", classificationVersion: 1 },
    values: {
      finalizedAt: "2026-08-11T20:00:00.000Z",
      cycleId: 71,
      rankInCycle: 10,
      submissionId: 812,
    },
  };
  const valid = cursorCodec.encodePublicPaginationCursor(payload, secret);
  const [body, signature] = valid.split(".");
  const tampered = `${body}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  const invalidPayloads = [
    { ...payload, values: { ...payload.values, rankInCycle: 0 } },
    { ...payload, context: { feed: "top10", classificationVersion: 0 } },
    {
      ...payload,
      values: { ...payload.values, finalizedAt: "2026-08-11 20:00:00" },
    },
    {
      ...payload,
      values: { ...payload.values, privateSignal: "leak" },
    },
  ];

  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        tampered,
        payload.scope,
        payload.context,
        secret,
      ),
    { name: "PublicPaginationCursorError" },
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursorForScope(
        tampered,
        payload.scope,
        secret,
      ),
    { name: "PublicPaginationCursorError" },
  );

  for (const invalid of invalidPayloads) {
    assert.throws(
      () =>
        cursorCodec.decodePublicPaginationCursor(
          signedBody(invalid),
          payload.scope,
          payload.context,
          secret,
        ),
      { name: "PublicPaginationCursorError" },
    );
  }
});

test("pure keyset filters encode every deterministic ordering component", () => {
  assert.equal(
    feed.getLiveFeedKeysetFilter({
      createdAt: "2026-08-12T10:15:30.000Z",
      submissionId: 901,
    }),
    "created_at.lt.2026-08-12T10:15:30.000Z,and(created_at.eq.2026-08-12T10:15:30.000Z,id.lt.901)",
  );
  assert.equal(
    feed.getFinalizedFeedKeysetFilter({
      finalizedAt: "2026-08-11T20:00:00.000Z",
      cycleId: 71,
      rankInCycle: 10,
      submissionId: 812,
    }),
    [
      "finalized_at.lt.2026-08-11T20:00:00.000Z",
      "and(finalized_at.eq.2026-08-11T20:00:00.000Z,cycle_id.lt.71)",
      "and(finalized_at.eq.2026-08-11T20:00:00.000Z,cycle_id.eq.71,rank_in_cycle.gt.10)",
      "and(finalized_at.eq.2026-08-11T20:00:00.000Z,cycle_id.eq.71,rank_in_cycle.eq.10,submission_id.gt.812)",
    ].join(","),
  );
});
