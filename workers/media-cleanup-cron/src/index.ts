const MEDIA_CLEANUP_PATH = "/api/internal/media-cleanup/process-due";
const MEDIA_CLEANUP_ENVIRONMENT_HEADER =
  "x-cancerculture-media-cleanup-environment";
const LIVE_TARGET_URL = `https://cancerculture.fun${MEDIA_CLEANUP_PATH}`;
const DEFAULT_TIMEOUT_MS = 25_000;

type MediaCleanupEnvironment = "dev" | "live";

export interface Env {
  MEDIA_CLEANUP_ENVIRONMENT: string;
  MEDIA_CLEANUP_TARGET_URL: string;
  MEDIA_CLEANUP_TRIGGER_SECRET: string;
}

type MediaCleanupResponse = {
  environment: MediaCleanupEnvironment;
  claimed: number;
  completed: number;
  recoveredUploads: number;
  queuedFromRecovery: number;
  retryScheduled: number;
  terminalFailures: number;
  staleResults: number;
  confirmationFailures: number;
  deletionFailures: number;
  batchesAttempted: number;
  dueDrained: boolean;
  fullyDrained: boolean;
  queue: {
    retryPending: number;
    dueRetryPending: number;
    processing: number;
    expiredProcessing: number;
    dead: number;
    outstanding: number;
  };
};

type FetchLike = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, "ok" | "status" | "json">>;

function isEnvironment(value: unknown): value is MediaCleanupEnvironment {
  return value === "dev" || value === "live";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isValidResponse(
  value: unknown,
  expectedEnvironment: MediaCleanupEnvironment
): value is MediaCleanupResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const queue = result.queue as Record<string, unknown> | null;
  const aggregateFields = [
    "claimed",
    "completed",
    "recoveredUploads",
    "queuedFromRecovery",
    "retryScheduled",
    "terminalFailures",
    "staleResults",
    "confirmationFailures",
    "deletionFailures",
    "batchesAttempted",
  ];
  const queueFields = [
    "retryPending",
    "dueRetryPending",
    "processing",
    "expiredProcessing",
    "dead",
    "outstanding",
  ];

  return (
    isEnvironment(result.environment) &&
    result.environment === expectedEnvironment &&
    aggregateFields.every((field) => isNonNegativeInteger(result[field])) &&
    typeof result.dueDrained === "boolean" &&
    typeof result.fullyDrained === "boolean" &&
    Boolean(queue) &&
    queueFields.every((field) => isNonNegativeInteger(queue?.[field]))
  );
}

function validateEnvironment(env: Env) {
  if (
    !isEnvironment(env.MEDIA_CLEANUP_ENVIRONMENT) ||
    env.MEDIA_CLEANUP_TRIGGER_SECRET.length < 32
  ) {
    throw new Error("MEDIA_CLEANUP_CRON_CONFIGURATION_ERROR");
  }

  let target: URL;
  try {
    target = new URL(env.MEDIA_CLEANUP_TARGET_URL);
  } catch {
    throw new Error("MEDIA_CLEANUP_CRON_CONFIGURATION_ERROR");
  }

  const isDevTarget =
    env.MEDIA_CLEANUP_ENVIRONMENT === "dev" &&
    target.pathname === MEDIA_CLEANUP_PATH &&
    target.search === "" &&
    target.hash === "" &&
    target.username === "" &&
    target.password === "" &&
    (target.hostname === "127.0.0.1" || target.hostname === "localhost") &&
    (target.protocol === "http:" || target.protocol === "https:");
  const isLiveTarget =
    env.MEDIA_CLEANUP_ENVIRONMENT === "live" &&
    target.toString() === LIVE_TARGET_URL;

  if (!isDevTarget && !isLiveTarget) {
    throw new Error("MEDIA_CLEANUP_CRON_TARGET_MISMATCH");
  }

  return {
    environment: env.MEDIA_CLEANUP_ENVIRONMENT,
    secret: env.MEDIA_CLEANUP_TRIGGER_SECRET,
    targetUrl: target.toString(),
  };
}

export async function runMediaCleanupCron(
  env: Env,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
) {
  const configuration = validateEnvironment(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(configuration.targetUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.secret}`,
        [MEDIA_CLEANUP_ENVIRONMENT_HEADER]: configuration.environment,
      },
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("MEDIA_CLEANUP_CRON_UNAUTHORIZED");
      }
      if (response.status === 503) {
        throw new Error("MEDIA_CLEANUP_CRON_WEBSITE_UNAVAILABLE");
      }
      throw new Error("MEDIA_CLEANUP_CRON_UNEXPECTED_HTTP_STATUS");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("MEDIA_CLEANUP_CRON_INVALID_RESPONSE");
    }

    if (!isValidResponse(body, configuration.environment)) {
      throw new Error("MEDIA_CLEANUP_CRON_INVALID_RESPONSE");
    }
    if (!body.dueDrained || body.queue.dueRetryPending > 0) {
      throw new Error("MEDIA_CLEANUP_CRON_DUE_DRAIN_INCOMPLETE");
    }
    if (body.terminalFailures > 0 || body.queue.dead > 0) {
      throw new Error("MEDIA_CLEANUP_CRON_TERMINAL_FAILURE");
    }
    if (
      body.staleResults > 0 ||
      body.confirmationFailures > 0 ||
      body.queue.expiredProcessing > 0
    ) {
      throw new Error("MEDIA_CLEANUP_CRON_CONFIRMATION_INCOMPLETE");
    }

    if (body.retryScheduled > 0 || body.queue.retryPending > 0) {
      console.warn("[media cleanup cron][retry pending]", {
        retryPending: body.queue.retryPending,
        retryScheduled: body.retryScheduled,
      });
    }

    return body;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("MEDIA_CLEANUP_CRON_TIMEOUT");
    }
    if (error instanceof Error && error.message.startsWith("MEDIA_CLEANUP_")) {
      throw error;
    }
    throw new Error("MEDIA_CLEANUP_CRON_NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

const mediaCleanupCronWorker = {
  async scheduled(
    _controller: { cron: string },
    env: Env
  ): Promise<void> {
    await runMediaCleanupCron(env);
  },

  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};

export default mediaCleanupCronWorker;
