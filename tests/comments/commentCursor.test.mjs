import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import ts from "typescript";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const temp = await mkdtemp(path.join(tmpdir(), "cc-comment-cursor-"));
after(() => rm(temp, { recursive: true, force: true }));
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pagination = await readFile(path.join(root, "lib/pagination/publicPagination.ts"), "utf8");
const cursor = await readFile(path.join(root, "lib/pagination/publicPaginationCursor.ts"), "utf8");
await writeFile(path.join(temp, "pagination.mjs"), transpile(pagination));
await writeFile(path.join(temp, "cursor.mjs"), transpile(cursor).replace('"./publicPagination"', '"./pagination.mjs"'));
const p = await import(pathToFileURL(path.join(temp, "pagination.mjs")));
const codec = await import(pathToFileURL(path.join(temp, "cursor.mjs")));
const secret = "c".repeat(32);

test("Comment root cursors bind submission, sort, snapshot, and full keyset", () => {
  const payload = {
    version: 1,
    scope: p.PUBLIC_PAGINATION_SCOPES.commentRootsTop,
    context: { submissionId: 42, sort: "top", contractVersion: 2 },
    values: {
      snapshotAt: "2026-08-23T12:00:00.000000+00:00",
      netScore: 0,
      createdAt: "2026-08-23T11:00:00.000000+00:00",
      publicCommentId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18422",
    },
  };
  const encoded = codec.encodePublicPaginationCursor(payload, secret);
  assert.deepEqual(codec.decodePublicPaginationCursor(encoded, payload.scope, payload.context, secret), payload);
  for (const context of [
    { ...payload.context, submissionId: 43 },
    { ...payload.context, sort: "newest" },
    { ...payload.context, contractVersion: 3 },
  ]) assert.throws(() => codec.decodePublicPaginationCursor(encoded, payload.scope, context, secret));
});

test("Reply cursors have an independent root-bound scope", () => {
  const payload = {
    version: 1,
    scope: p.PUBLIC_PAGINATION_SCOPES.commentReplies,
    context: {
      submissionId: 42,
      rootPublicCommentId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18422",
      contractVersion: 2,
    },
    values: {
      snapshotAt: "2026-08-23T12:00:00.000000+00:00",
      createdAt: "2026-08-23T11:00:00.000000+00:00",
      publicCommentId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18423",
    },
  };
  const encoded = codec.encodePublicPaginationCursor(payload, secret);
  assert.deepEqual(codec.decodePublicPaginationCursor(encoded, payload.scope, payload.context, secret), payload);
  assert.throws(() => codec.decodePublicPaginationCursor(encoded, payload.scope, {
    ...payload.context,
    rootPublicCommentId: "018f0ed0-5c89-4c0f-9c38-8cebd4e18424",
  }, secret));
});
