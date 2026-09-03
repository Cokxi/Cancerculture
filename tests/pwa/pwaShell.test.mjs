import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import sharp from "sharp";
import { GET as getServiceWorker } from "../../app/sw.js/route.ts";

const root = new URL("../../", import.meta.url);
const readRepoFile = (path) => readFile(new URL(path, root), "utf8");

test("PWA manifest and metadata expose a stable standalone install identity", async () => {
  const [manifest, layout] = await Promise.all([
    readRepoFile("app/manifest.ts"),
    readRepoFile("app/layout.tsx"),
  ]);

  assert.match(manifest, /id: "\/"/u);
  assert.match(manifest, /name: "CancerCulture"/u);
  assert.match(manifest, /short_name: "CCulture"/u);
  assert.match(manifest, /start_url: "\/"/u);
  assert.match(manifest, /scope: "\/"/u);
  assert.match(manifest, /display: "standalone"/u);
  assert.match(manifest, /background_color: "#0b0b0b"/u);
  assert.match(manifest, /theme_color: "#ff5a1f"/u);
  assert.match(manifest, /pwa-icon-192\.png/u);
  assert.match(manifest, /pwa-icon-512\.png/u);
  assert.match(manifest, /src: "\/icons\/pwa-icon-maskable-512\.png\?v=cc-v1-maskable-1",\s+sizes: "512x512",\s+type: "image\/png",\s+purpose: "maskable"/u);
  assert.equal(manifest.match(/purpose: "any"/gu)?.length, 2);
  assert.equal(manifest.match(/purpose: "maskable"/gu)?.length, 1);
  assert.equal(manifest.match(/\?v=cc-v5/gu)?.length, 2);
  assert.doesNotMatch(manifest, /prefer_related_applications|screenshots|shortcuts/u);

  assert.match(layout, /manifest: "\/manifest\.webmanifest"/u);
  assert.match(layout, /pwa-icon-192\.png/u);
  assert.match(layout, /apple-touch-icon\.png/u);
  assert.doesNotMatch(layout, /pwa-icon\.svg/u);
  assert.equal(layout.match(/\?v=cc-v5/gu)?.length, 2);
  assert.match(layout, /themeColor: "#ff5a1f"/u);
  assert.equal(layout.match(/<PwaShell \/>/gu)?.length, 1);
});

test("PNG icons preserve real transparency and provide the required install sizes", async () => {
  const icons = [
    ["public/icons/pwa-icon-192.png", 192],
    ["public/icons/pwa-icon-512.png", 512],
    ["public/icons/apple-touch-icon.png", 180],
  ];

  for (const [path, size] of icons) {
    const metadata = await sharp(fileURLToPath(new URL(path, root))).metadata();
    assert.equal(metadata.format, "png", path);
    assert.equal(metadata.width, size, path);
    assert.equal(metadata.height, size, path);
    assert.equal(metadata.hasAlpha, true, `${path} must retain alpha`);
    const stats = await sharp(fileURLToPath(new URL(path, root))).stats();
    assert.equal(stats.isOpaque, false, `${path} must contain transparent pixels`);
    assert.equal(stats.channels[3].min, 0, `${path} must retain fully transparent pixels`);
    assert.equal(stats.channels[3].max, 255, `${path} must retain opaque artwork`);
  }

  for (const obsolete of ["app/favicon.ico", "public/icons/pwa-icon.svg"]) {
    await assert.rejects(readFile(new URL(obsolete, root)), { code: "ENOENT" });
  }
});

test("dedicated maskable PNG fills the Android mask with an opaque dark background", async () => {
  const icon = fileURLToPath(new URL("public/icons/pwa-icon-maskable-512.png", root));
  const metadata = await sharp(icon).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal((await sharp(icon).stats()).isOpaque, true);

  // Padding is artwork-specific. Keep it dark instead of leaving transparent
  // margins that the launcher could composite against a white background.
  for (const [left, top, width, height] of [
    [0, 0, 512, 32], [0, 480, 512, 32],
    [0, 32, 32, 448], [480, 32, 32, 448],
  ]) {
    const region = await sharp(icon).extract({ left, top, width, height }).toBuffer();
    const stats = await sharp(region).stats();
    for (const channel of stats.channels.slice(0, 3)) assert.equal(channel.max, 0);
  }
});

test("install presentation is mobile-only, truthful, and disappears in standalone mode", async () => {
  const [shell, styles] = await Promise.all([
    readRepoFile("app/components/pwa/PwaShell.tsx"),
    readRepoFile("app/globals.css"),
  ]);

  assert.match(shell, /beforeinstallprompt/u);
  assert.match(shell, /promptEvent\.preventDefault\(\)/u);
  assert.match(shell, /appinstalled/u);
  assert.match(shell, /\(display-mode: standalone\)/u);
  assert.match(shell, /navigatorWithStandalone\.standalone === true/u);
  assert.match(shell, /\(pointer: coarse\)/u);
  assert.match(shell, /iPad\|iPhone\|iPod/u);
  assert.match(shell, /Add to Home Screen/u);
  assert.match(shell, /pathname\.startsWith\("\/admin\/"\)/u);
  assert.match(shell, /data-pwa-install/u);
  assert.match(styles, /@media \(display-mode: standalone\)/u);
  assert.match(styles, /safe-area-inset-top/u);
  assert.match(styles, /body:has\(\[data-hides-global-account\]\) \[data-pwa-install\]/u);
});

test("service worker is network-only and updates only after explicit confirmation", async () => {
  const [shell, route] = await Promise.all([
    readRepoFile("app/components/pwa/PwaShell.tsx"),
    readRepoFile("app/sw.js/route.ts"),
  ]);

  assert.match(shell, /process\.env\.NODE_ENV !== "production"/u);
  assert.match(shell, /navigator\.serviceWorker\.register\("\/sw\.js"/u);
  assert.match(shell, /updateViaCache: "none"/u);
  assert.match(shell, /registration\.waiting/u);
  assert.match(shell, /updatefound/u);
  assert.match(shell, /controllerchange/u);
  assert.match(shell, /if \(!refreshRequestedRef\.current\) return;/u);
  assert.match(shell, /waitingWorker\.postMessage\(\{ type: "SKIP_WAITING" \}\)/u);
  assert.match(shell, /Update now/u);
  assert.match(shell, /Later/u);
  assert.doesNotMatch(shell, /setInterval|caches\.|CacheStorage/u);

  assert.match(route, /"Cache-Control": "no-store, max-age=0"/u);
  assert.match(route, /"Service-Worker-Allowed": "\/"/u);
  assert.match(route, /self\.clients\.claim\(\)/u);
  assert.match(route, /event\.data\?\.type === "SKIP_WAITING"/u);
  assert.equal(route.match(/self\.skipWaiting\(\)/gu)?.length, 1);
  assert.match(route, /addEventListener\("push"/u);
  assert.match(route, /addEventListener\("notificationclick"/u);
  assert.match(route, /getServiceWorkerPushAllowlist/u);
  assert.match(route, /const PUSH_MESSAGES = new Map/u);
  assert.match(route, /PUSH_MESSAGES\.get\(JSON\.stringify\(\[value\.title, value\.body\]\)\) !== value\.category/u);
  assert.match(route, /NOTIFICATION_ID_PATTERN/u);
  assert.match(route, /NOTIFICATION_OPEN_PATH_PATTERN/u);
  assert.match(route, /"\/notifications\/open\/" \+ value\.notificationId/u);
  assert.match(route, /self\.clients\.matchAll\(\{ type: "window", includeUncontrolled: true \}\)/u);
  assert.match(route, /self\.clients\.openWindow\(url\)/u);
  assert.match(route, /candidate === "\/notifications"/u);
  assert.doesNotMatch(
    route,
    /addEventListener\("fetch"|addEventListener\("sync"|caches\.|cache\.add|cache\.put|CacheStorage|backgroundSync/u
  );

  const response = getServiceWorker();
  const deliveredWorker = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotThrow(
    () => new Script(deliveredWorker, { filename: "delivered-sw.js" }),
    "the actual generated Service Worker must compile as JavaScript"
  );
  assert.match(deliveredWorker, /NOTIFICATION_OPEN_PATH_PATTERN/u);
});
