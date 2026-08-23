import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  getSubmissionThumbnailUrl,
  SUBMISSION_THUMBNAIL_TRANSFORM,
} from "../../lib/r2/getSubmissionThumbnailUrl.ts";

const repoRoot = new URL("../../", import.meta.url);

async function listSourceFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);

      return entry.isDirectory()
        ? listSourceFiles(entryUrl)
        : [entryUrl];
    })
  );

  return nestedFiles.flat();
}

test("submission thumbnails use one canonical Cloudflare transform", () => {
  assert.equal(SUBMISSION_THUMBNAIL_TRANSFORM, "w=400,q=75");
  assert.equal(
    getSubmissionThumbnailUrl("https://media.example.com/submissions/cycle/image.webp"),
    "https://media.example.com/cdn-cgi/image/w=400,q=75/submissions/cycle/image.webp"
  );
});

test("submission thumbnail URLs preserve source query parameters", () => {
  assert.equal(
    getSubmissionThumbnailUrl("https://media.example.com/image.webp?version=2#preview"),
    "https://media.example.com/cdn-cgi/image/w=400,q=75/image.webp?version=2"
  );
});

test("Cloudflare submission transforms stay centralized", async () => {
  const sourceFiles = (
    await Promise.all([
      listSourceFiles(new URL("app/", repoRoot)),
      listSourceFiles(new URL("lib/", repoRoot)),
    ])
  )
    .flat()
    .filter((url) => /\.(?:ts|tsx)$/u.test(url.pathname));
  const directTransformUsers = [];

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    if (source.includes("/cdn-cgi/image/")) {
      directTransformUsers.push(sourceFile.pathname.replace(repoRoot.pathname, ""));
    }
  }

  assert.deepEqual(directTransformUsers, [
    "lib/r2/getSubmissionThumbnailUrl.ts",
  ]);
});

test("preview surfaces use thumbnails while full-size views keep originals", async () => {
  const previewPaths = [
    "app/admin/moderation/disqualified/page.tsx",
    "lib/admin/moderationLogs.ts",
    "app/admin/users/UserSubmissionsDropdown.tsx",
    "app/cycle-history/CycleHistoryClient.tsx",
    "app/my-profile/ProfileHistoryLists.tsx",
    "app/my-profile/page.tsx",
    "app/profile/[publicProfileId]/page.tsx",
    "app/submissions/SubmissionsClient.tsx",
    "app/wall/fame/FameGrid.tsx",
    "app/wall/shame/ShameGrid.tsx",
  ];
  const previewSources = await Promise.all(
    previewPaths.map((path) => readFile(new URL(path, repoRoot), "utf8"))
  );

  for (const source of previewSources) {
    assert.match(source, /getSubmissionThumbnailUrl/u);
  }

  const moderationLogList = await readFile(
    new URL(
      "app/admin/logs/moderation/moderation-log-list.tsx",
      repoRoot
    ),
    "utf8"
  );
  assert.match(
    moderationLogList,
    /src=\{log\.submission_thumbnail_url\}/u
  );

  const [submissions, cycleHistory, fame, shame] = await Promise.all(
    [
      "app/submissions/SubmissionsClient.tsx",
      "app/cycle-history/CycleHistoryClient.tsx",
      "app/wall/fame/FameGrid.tsx",
      "app/wall/shame/ShameGrid.tsx",
    ].map((path) => readFile(new URL(path, repoRoot), "utf8"))
  );

  assert.match(submissions, /src=\{active\.image_url\}/u);
  assert.match(cycleHistory, /src=\{submission\.imageUrl\}/u);
  assert.match(fame, /src=\{active\.image_url\}/u);
  assert.match(shame, /src=\{active\.image_url\}/u);
});

test("Cycle History thumbnails use a responsive fill frame without aspect-ratio warnings", async () => {
  const cycleHistory = await readFile(
    new URL("app/cycle-history/CycleHistoryClient.tsx", repoRoot),
    "utf8"
  );

  assert.match(
    cycleHistory,
    /className="relative h-56 w-full overflow-hidden rounded-lg"[\s\S]*?<Image/u
  );
  assert.match(cycleHistory, /\bfill\b/u);
  assert.match(
    cycleHistory,
    /sizes="\(max-width: 639px\) 100vw, \(max-width: 1279px\) 50vw, 33vw"/u
  );
  assert.match(cycleHistory, /className="object-cover"/u);
  assert.doesNotMatch(
    cycleHistory,
    /width=\{400\}[\s\S]*?height=\{224\}[\s\S]*?className="h-56 w-full/u
  );
});
