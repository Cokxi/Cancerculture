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
  assert.match(closeButton, /h-11 w-11/);
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

test("submission details and overlays hide the global account control on mobile only", async () => {
  const [globalAccount, globalStyles, detailPage, overlayProvider, ...modals] =
    await Promise.all([
      readRepoFile("app/components/auth/GlobalAccount.tsx"),
      readRepoFile("app/globals.css"),
      readRepoFile("app/spread/[submissionId]/page.tsx"),
      readRepoFile("app/components/overlay/OverlayProvider.tsx"),
      ...modalConsumers
        .filter(
          (path) => path !== "app/components/profile/VisitProfilePrompt.tsx"
        )
        .map(readRepoFile),
    ]);

  assert.match(globalAccount, /data-global-account/u);
  assert.match(
    globalStyles,
    /@media \(max-width: 639px\)[\s\S]*body:has\(\[data-hides-global-account\]\) \[data-global-account\][\s\S]*display: none/u
  );
  assert.match(detailPage, /data-hides-global-account/u);
  assert.match(overlayProvider, /data-hides-global-account/u);

  for (const modal of modals) {
    assert.match(modal, /data-hides-global-account/u);
  }
});
