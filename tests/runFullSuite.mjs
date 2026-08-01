import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const testsRoot = path.join(repoRoot, "tests");

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectTestFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".test.mjs")
      ? [entryPath]
      : [];
  });
}

const testFiles = collectTestFiles(testsRoot).sort((left, right) =>
  left.localeCompare(right, "en"),
);

if (testFiles.length === 0) {
  console.error("No .test.mjs files found below tests/.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--experimental-loader",
    "./tests/integration/nextAliasLoader.mjs",
    "--test",
    ...testFiles,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error("Unable to start the full test suite:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
