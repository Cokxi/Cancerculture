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
    "$1"
  )
);
const tempDirectory = await mkdtemp(
  path.join(tmpdir(), "cc-public-pagination-")
);

after(async () => {
  await rm(tempDirectory, { recursive: true, force: true });
});

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function transpile(sourceText) {
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

const [
  paginationSource,
  cursorSource,
  serverCursorSource,
  mergeSource,
] =
  await Promise.all([
    source("lib/pagination/publicPagination.ts"),
    source("lib/pagination/publicPaginationCursor.ts"),
    source(
      "lib/pagination/publicPaginationCursor.server.ts"
    ),
    source("lib/pagination/mergePublicPageItems.ts"),
  ]);

await Promise.all([
  writeFile(
    path.join(tempDirectory, "publicPagination.mjs"),
    transpile(paginationSource),
    "utf8"
  ),
  writeFile(
    path.join(tempDirectory, "publicPaginationCursor.mjs"),
    transpile(cursorSource).replace(
      '"./publicPagination"',
      '"./publicPagination.mjs"'
    ),
    "utf8"
  ),
  writeFile(
    path.join(
      tempDirectory,
      "publicPaginationCursor.server.mjs"
    ),
    transpile(serverCursorSource)
      .replace('import "server-only";', "")
      .replace(
        '"./publicPaginationCursor"',
        '"./publicPaginationCursor.mjs"'
      ),
    "utf8"
  ),
  writeFile(
    path.join(tempDirectory, "mergePublicPageItems.mjs"),
    transpile(mergeSource),
    "utf8"
  ),
]);

const pagination = await import(
  pathToFileURL(
    path.join(tempDirectory, "publicPagination.mjs")
  )
);
const cursorCodec = await import(
  pathToFileURL(
    path.join(tempDirectory, "publicPaginationCursor.mjs")
  )
);
const serverCursor = await import(
  pathToFileURL(
    path.join(
      tempDirectory,
      "publicPaginationCursor.server.mjs"
    )
  )
);
const paginationMerge = await import(
  pathToFileURL(
    path.join(tempDirectory, "mergePublicPageItems.mjs")
  )
);

const secret = "p".repeat(32);

function signedBody(value) {
  const body = Buffer.from(
    JSON.stringify(value),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

test("the shared public page size is fixed at 48", () => {
  assert.equal(pagination.PUBLIC_SUBMISSION_PAGE_SIZE, 48);
});

test("versioned signed cursors round-trip only in their scope and context", () => {
  const payload = {
    version: pagination.PUBLIC_PAGINATION_CURSOR_VERSION,
    scope: pagination.PUBLIC_PAGINATION_SCOPES.submissions,
    context: { cycleId: 12 },
    values: { id: 48 },
  };
  const cursor = cursorCodec.encodePublicPaginationCursor(
    payload,
    secret
  );
  const repeatedCursor =
    cursorCodec.encodePublicPaginationCursor(payload, secret);

  assert.equal(repeatedCursor, cursor);
  assert.deepEqual(
    cursorCodec.decodePublicPaginationCursor(
      cursor,
      pagination.PUBLIC_PAGINATION_SCOPES.submissions,
      { cycleId: 12 },
      secret
    ),
    payload
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.historySubmissions,
        { cycleId: 12, view: "public" },
        secret
      ),
    { name: "PublicPaginationCursorError" }
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.submissions,
        { cycleId: 13 },
        secret
      ),
    { name: "PublicPaginationCursorError" }
  );
  assert.throws(
    () =>
      cursorCodec.decodePublicPaginationCursor(
        cursor,
        pagination.PUBLIC_PAGINATION_SCOPES.submissions,
        { cycleId: 12 },
        "q".repeat(32)
      ),
    { name: "PublicPaginationCursorError" }
  );
});

test("the server cursor secret is dedicated and fails closed", () => {
  assert.throws(
    () =>
      serverCursor.resolvePublicPaginationCursorSecret({}),
    {
      name: "PublicPaginationConfigurationError",
      message: "PUBLIC_PAGINATION_CURSOR_SECRET_MISSING",
    }
  );
  assert.throws(
    () =>
      serverCursor.resolvePublicPaginationCursorSecret({
        PUBLIC_PAGINATION_CURSOR_SECRET: "s".repeat(31),
      }),
    {
      name: "PublicPaginationConfigurationError",
      message: "PUBLIC_PAGINATION_CURSOR_SECRET_TOO_SHORT",
    }
  );
  assert.throws(
    () =>
      serverCursor.resolvePublicPaginationCursorSecret({
        SUPABASE_SERVICE_ROLE_KEY: "s".repeat(64),
      }),
    {
      name: "PublicPaginationConfigurationError",
      message: "PUBLIC_PAGINATION_CURSOR_SECRET_MISSING",
    }
  );

  assert.equal(
    serverCursor.resolvePublicPaginationCursorSecret({
      PUBLIC_PAGINATION_CURSOR_SECRET: secret,
    }).length,
    32
  );
});

test("tampered, incomplete, and unsupported cursors fail closed", () => {
  const valid = cursorCodec.encodePublicPaginationCursor(
    {
      version: 1,
      scope: "fame",
      context: { wall: "fame" },
      values: {
        createdAt: "2026-07-28T10:00:00.000Z",
        id: 99,
      },
    },
    secret
  );
  const tampered = `${valid.slice(0, -1)}${
    valid.endsWith("A") ? "B" : "A"
  }`;

  for (const cursor of [
    tampered,
    signedBody({
      version: 1,
      scope: "fame",
      context: { wall: "fame" },
    }),
    signedBody({
      version: 2,
      scope: "fame",
      context: { wall: "fame" },
      values: {
        createdAt: "2026-07-28T10:00:00.000Z",
        id: 99,
      },
    }),
  ]) {
    assert.throws(
      () =>
        cursorCodec.decodePublicPaginationCursor(
          cursor,
          "fame",
          { wall: "fame" },
          secret
        ),
      { name: "PublicPaginationCursorError" }
    );
  }
});

test("deduplication preserves existing items and stable order", () => {
  assert.deepEqual(
    paginationMerge.mergePublicPageItems(
      [{ id: 1 }, { id: 2 }],
      [{ id: 2 }, { id: 3 }],
      (item) => item.id
    ),
    [{ id: 1 }, { id: 2 }, { id: 3 }]
  );
});

test("all public list helpers use bounded keyset queries and scoped cursors", async () => {
  const [
    submissions,
    wall,
    history,
    voteRoute,
    wallRoute,
    historyRoute,
  ] = await Promise.all([
    source("lib/vote/getVoteSubmissions.ts"),
    source("lib/walls/getPublicWallPage.ts"),
    source("lib/cycles/getCycleHistoryData.ts"),
    source("app/api/vote/submissions/route.ts"),
    source("app/api/wall/[wall]/route.ts"),
    source("app/api/cycle-history/route.ts"),
  ]);

  for (const helper of [submissions, wall, history]) {
    assert.match(
      helper,
      /PUBLIC_SUBMISSION_PAGE_SIZE \+ 1/
    );
    assert.match(helper, /nextCursor/);
    assert.match(helper, /hasMore/);
    assert.doesNotMatch(helper, /\.range\(/);
  }

  assert.match(submissions, /\.gt\("id"/);
  assert.match(submissions, /scope: PUBLIC_PAGINATION_SCOPES\.submissions/);
  assert.match(wall, /\.eq\("wall", wall\)/);
  assert.match(wall, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(wall, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(history, /PUBLIC_PAGINATION_SCOPES\.historyCycles/);
  assert.match(
    history,
    /PUBLIC_PAGINATION_SCOPES\.historySubmissions/
  );
  assert.match(history, /count: "exact", head: true/);
  assert.doesNotMatch(voteRoute, /offset|limit/);

  for (const route of [voteRoute, wallRoute, historyRoute]) {
    assert.match(route, /Cache-Control": "no-store"/);
  }
});

test("load-more UX blocks parallel loads and exposes accessible states", async () => {
  const [hook, button] = await Promise.all([
    source("lib/pagination/usePublicPagination.ts"),
    source("app/components/ui/LoadMoreButton.tsx"),
  ]);

  assert.match(hook, /loadingRef\.current/);
  assert.match(hook, /mergePublicPageItems/);
  assert.match(hook, /setError\("Could not load more/);
  assert.match(hook, /const loadUntil = useCallback/);
  assert.match(hook, /while \(pageHasMore && cursor\)/);
  assert.match(button, /aria-busy=\{isLoading\}/);
  assert.match(button, /disabled=\{isLoading\}/);
  assert.match(button, /role="alert"/);
  assert.match(button, /cursor-pointer/);
  assert.match(button, /hover:/);
  assert.match(button, /focus-visible:/);
  assert.match(button, /active:/);
  assert.match(button, /disabled:/);
});

test("history keeps cycles and their submission pages independently reachable", async () => {
  const [page, client, cycleRoute] = await Promise.all([
    source("app/cycle-history/page.tsx"),
    source("app/cycle-history/CycleHistoryClient.tsx"),
    source("app/api/cycle-history/[cycleId]/route.ts"),
  ]);

  assert.match(page, /getCycleHistorySummariesPage/);
  assert.match(client, /loadMoreCycles/);
  assert.match(client, /loadMoreCycle/);
  assert.match(client, /loadCyclesUntil/);
  assert.match(client, /mergePublicPageItems/);
  assert.match(client, /<SubmissionModal/);
  assert.match(cycleRoute, /getCycleHistorySubmissionPage/);
});

test("loaded current submissions retain vote and modal state", async () => {
  const client = await source(
    "app/submissions/SubmissionsClient.tsx"
  );

  assert.match(
    client,
    /localVotes\[s\.id\] \?\? s\.vote_count/
  );
  assert.match(
    client,
    /localVotes\[active\.id\] \?\? active\.vote_count/
  );
  assert.match(client, /votedSubmissionIdSet\.has\(active\.id\)/);
  assert.match(
    client,
    /active\.discord_user_id !== discordUserId/
  );
});
