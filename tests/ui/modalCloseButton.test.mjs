import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readRepoFile = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const modalConsumers = [
  "app/components/overlay/BaseOverlay.tsx",
  "app/components/profile/VisitProfilePrompt.tsx",
  "app/submissions/SubmissionsClient.tsx",
  "app/wall/fame/FameGrid.tsx",
  "app/wall/shame/ShameGrid.tsx",
  "app/cycle-history/CycleHistoryClient.tsx",
];

test("shared modal close button exposes the visual and interaction contract", async () => {
  const closeButton = await readRepoFile(
    "app/components/ui/ModalCloseButton.tsx"
  );

  assert.match(closeButton, /aria-label="Close modal"/);
  assert.match(closeButton, />\s*×\s*</);
  assert.match(closeButton, /absolute right-2 top-2/);
  assert.match(closeButton, /h-10 w-10/);
  assert.match(closeButton, /cursor-pointer/);
  assert.match(closeButton, /hover:bg-black\/90/);
  assert.match(closeButton, /focus-visible:ring-2/);
  assert.match(closeButton, /active:scale-95/);
});

test("every modal close control uses the shared container-relative button", async () => {
  const sources = await Promise.all(modalConsumers.map(readRepoFile));

  for (const [index, source] of sources.entries()) {
    assert.match(
      source,
      /<ModalCloseButton /,
      `${modalConsumers[index]} must use ModalCloseButton`
    );
    assert.doesNotMatch(
      source,
      /className="fixed top-4 right-4/,
      `${modalConsumers[index]} must not position a close button on the viewport`
    );
  }
});
