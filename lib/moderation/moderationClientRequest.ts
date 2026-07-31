export const STALE_MODERATION_MESSAGE =
  "This submission was already updated. The view has been refreshed.";
export const NETWORK_MODERATION_MESSAGE =
  "The moderation request could not be completed. Check your connection and try again.";

type PendingRequestRef = { current: boolean };

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

async function readErrorMessage(response: Response) {
  const payload = await response.json().catch(() => null);
  return typeof payload?.error === "string"
    ? payload.error
    : "Moderation action failed.";
}

export async function performModerationClientRequest({
  endpoint,
  body,
  fetcher = fetch,
  showMessage = (message) => window.alert(message),
  refresh = () => window.location.reload(),
}: {
  endpoint: "/api/admin/disqualify" | "/api/admin/reinstate";
  body: Record<string, unknown>;
  fetcher?: typeof fetch;
  showMessage?: (message: string) => void;
  refresh?: () => void;
}) {
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    showMessage(NETWORK_MODERATION_MESSAGE);
    return "network-error" as const;
  }

  if (response.ok) {
    refresh();
    return "success" as const;
  }

  if (response.status === 409) {
    showMessage(STALE_MODERATION_MESSAGE);
    refresh();
    return "stale" as const;
  }

  if (response.status === 403) {
    showMessage(await readErrorMessage(response));
    return "forbidden" as const;
  }

  if (response.status === 503) {
    showMessage(await readErrorMessage(response));
    return "unavailable" as const;
  }

  showMessage(await readErrorMessage(response));
  return "error" as const;
}
