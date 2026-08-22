export const dynamic = "force-dynamic";

import { getServiceWorkerPushAllowlist } from "@/lib/notifications/pushPayload";

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
  const pushAllowlist = getServiceWorkerPushAllowlist().map((content) => [
    JSON.stringify([content.title, content.body]),
    content.categoryKey,
  ]);
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

const PUSH_MESSAGES = new Map(${JSON.stringify(pushAllowlist)});
const NOTIFICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_OPEN_PATH_PATTERN = /^\\/notifications\\/open\\/[0-9a-f-]{36}$/;

function safePushMessage(event) {
  try {
    const value = event.data?.json();
    if (
      !value ||
      PUSH_MESSAGES.get(JSON.stringify([value.title, value.body])) !== value.category ||
      typeof value.category !== "string" ||
      !/^[a-z][a-z0-9_]{2,63}$/.test(value.category) ||
      typeof value.notificationId !== "string" ||
      !NOTIFICATION_ID_PATTERN.test(value.notificationId)
    ) throw new Error("invalid");
    return {
      title: value.title,
      body: value.body,
      url: "/notifications/open/" + value.notificationId,
      tag: "account-notification:" + value.notificationId,
    };
  } catch {
    return {
      title: "CancerCulture",
      body: "You have a new private update.",
      url: "/notifications",
      tag: "account-notification",
    };
  }
}

self.addEventListener("push", (event) => {
  const message = safePushMessage(event);
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    data: { url: message.url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const candidate = event.notification.data?.url;
  const url = typeof candidate === "string" && (
    candidate === "/notifications" ||
    NOTIFICATION_OPEN_PATH_PATTERN.test(candidate)
  ) ? candidate : "/notifications";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      if ("navigate" in existing) await existing.navigate(url);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  })());
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
