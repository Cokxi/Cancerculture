export const dynamic = "force-dynamic";

const VERSION_ENVIRONMENT_KEYS = [
  "APP_BUILD_VERSION",
  "VERCEL_GIT_COMMIT_SHA",
  "CF_PAGES_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

function getServiceWorkerVersion() {
  for (const key of VERSION_ENVIRONMENT_KEYS) {
    const value = process.env[key]?.trim();
    if (value && /^[A-Za-z0-9._-]{1,128}$/u.test(value)) return value;
  }

  return "unversioned";
}

function renderServiceWorker(version: string) {
  return `"use strict";

const SERVICE_WORKER_VERSION = ${JSON.stringify(version)};

self.addEventListener("install", () => {
  // Intentionally empty: this shell never precaches application responses.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

void SERVICE_WORKER_VERSION;
`;
}

export function GET() {
  return new Response(renderServiceWorker(getServiceWorkerVersion()), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "text/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
