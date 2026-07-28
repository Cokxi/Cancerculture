import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("home hero keeps animated cells in a contained background layer", async () => {
  const home = await readRepoFile("app/page.tsx");

  assert.match(
    home,
    /<main className="relative isolate w-full bg-orange-background/
  );
  assert.match(
    home,
    /relative isolate flex min-h-\[calc\(100svh-7rem\)\]/
  );
  assert.match(home, /className="relative w-full sm:static"/);
  assert.match(home, /relative z-0 mb-\[-0\.5rem\] flex w-full/);
  assert.match(home, /w-\[min\(42vw,152px\)\]/);
  assert.match(
    home,
    /<TelegramCellAnimated \/>\s*<\/div>\s*<\/div>\s*<CycleHud \/>/
  );
  assert.match(home, /relative z-20 -translate-y-2 animate-breathe/);
  assert.doesNotMatch(home, /scale-\[0\.38\]|gap-\[-20px\]/);
});

test("HUD overlays the mobile cell group and preserves the desktop anchor", async () => {
  const cycleHud = await readRepoFile("app/components/CycleHud.tsx");

  assert.match(
    cycleHud,
    /pointer-events-none absolute inset-0 z-20 flex items-center justify-center/
  );
  assert.match(
    cycleHud,
    /sm:inset-auto sm:left-0 sm:top-\[150px\] sm:w-full/
  );
  assert.match(cycleHud, /max-w-\[88vw\].*break-words/);
  assert.match(cycleHud, /className="pointer-events-auto text-green-400/);
  assert.doesNotMatch(cycleHud, /pointer-events-none relative/);
  assert.doesNotMatch(cycleHud, /\babsolute\s+top-\[150px\]\s+z-0/);
});

test("cell media cannot intercept input while their intentional links remain interactive", async () => {
  const cells = await Promise.all(
    [
      "app/components/DiscordCellAnimated.tsx",
      "app/components/TelegramCellAnimated.tsx",
    ].map(readRepoFile)
  );

  for (const cell of cells) {
    assert.match(
      cell,
      /className="group relative block w-full cursor-pointer"/
    );
    assert.match(cell, /pointer-events-none/);
    assert.match(cell, /\bw-full\b/);
    assert.doesNotMatch(cell, /w-\[400px\]/);
  }
});
