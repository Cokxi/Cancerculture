export const STALE_MODERATION_MESSAGE =
  "This submission was already updated. The view will now be refreshed.";
export const ALREADY_CURRENT_MODERATION_MESSAGE =
  "This submission is already in the requested state.";
export const NETWORK_MODERATION_MESSAGE =
  "The moderation request could not be completed. Check your connection and try again.";

type PendingRequestRef = { current: boolean };
type ModerationClientOutcome =
  | { kind: "changed" | "replayed" }
  | { kind: "already-current" | "stale" }
  | {
      kind: "forbidden" | "unavailable" | "error";
      message: string;
    }
  | { kind: "network-error" };

export function tryBeginModerationRequest(
  pending: PendingRequestRef
) {
  if (pending.current) return false;
  pending.current = true;
  return true;
}

export function finishModerationRequest(pending: PendingRequestRef) {
  pending.current = false;
}

export function createModerationIdempotencyKey(
  randomUUID = () => crypto.randomUUID()
) {
  return randomUUID();
}

export function waitForModerationPendingPaint() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function readPayload(response: Response) {
  return response.json().catch(() => null);
}

async function readOutcome(
  response: Response
): Promise<ModerationClientOutcome> {
  const payload = await readPayload(response);

  if (response.ok) {
    const result = payload?.result;
    if (
      payload?.success !== true ||
      typeof result?.changed !== "boolean" ||
      typeof result?.replayed !== "boolean"
    ) {
      return {
        kind: "unavailable",
        message: "Submission moderation returned an invalid response.",
      };
    }
    if (result.replayed) return { kind: "replayed" };
    if (result.changed) return { kind: "changed" };
    return { kind: "already-current" };
  }

  if (response.status === 409) return { kind: "stale" };

  const message =
    typeof payload?.error === "string"
      ? payload.error
      : "Moderation action failed.";
  if (response.status === 403) return { kind: "forbidden", message };
  if (response.status === 503) return { kind: "unavailable", message };
  return { kind: "error", message };
}

export async function performModerationClientRequest({
  endpoint,
  body,
  finishPending,
  fetcher = fetch,
  showMessage = (message) => window.alert(message),
  refresh = () => window.location.reload(),
}: {
  endpoint: "/api/admin/disqualify" | "/api/admin/reinstate";
  body: Record<string, unknown>;
  finishPending: () => void | Promise<void>;
  fetcher?: typeof fetch;
  showMessage?: (message: string) => void;
  refresh?: () => void;
}) {
  let outcome: ModerationClientOutcome;
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    outcome = await readOutcome(response);
  } catch {
    outcome = { kind: "network-error" };
  } finally {
    await finishPending();
  }

  if (outcome.kind === "changed" || outcome.kind === "replayed") {
    refresh();
  } else if (outcome.kind === "already-current") {
    showMessage(ALREADY_CURRENT_MODERATION_MESSAGE);
    refresh();
  } else if (outcome.kind === "stale") {
    showMessage(STALE_MODERATION_MESSAGE);
    refresh();
  } else if (outcome.kind === "network-error") {
    showMessage(NETWORK_MODERATION_MESSAGE);
  } else if ("message" in outcome) {
    showMessage(outcome.message);
  }

  return outcome.kind;
}
