import "server-only";

import {
  resolveWriteGateMode,
  WRITE_GATE_RETRY_AFTER_SECONDS,
  type WriteGateMode,
} from "@/lib/writeGate";

export class WriteGateClosedError extends Error {
  readonly code = "WRITE_GATE_CLOSED";

  constructor() {
    super("Service temporarily unavailable");
    this.name = "WriteGateClosedError";
  }
}

export function getServerWriteGateMode(): WriteGateMode {
  return resolveWriteGateMode({
    configuredMode: process.env.CANCERCULTURE_WRITE_MODE,
    nodeEnvironment: process.env.NODE_ENV,
  });
}

export function assertServerMutationAllowed(options?: { allowDrain?: boolean }) {
  const mode = getServerWriteGateMode();
  if (mode === "open" || (mode === "drain" && options?.allowDrain === true)) {
    return;
  }
  throw new WriteGateClosedError();
}

export function enforceRouteMutationGate(options?: { allowDrain?: boolean }) {
  try {
    assertServerMutationAllowed(options);
    return null;
  } catch (error) {
    if (error instanceof WriteGateClosedError) {
      return writeGateUnavailableResponse();
    }
    throw error;
  }
}

export function writeGateUnavailableResponse() {
  return Response.json(
    { error: "Service temporarily unavailable" },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(WRITE_GATE_RETRY_AFTER_SECONDS),
      },
    }
  );
}
