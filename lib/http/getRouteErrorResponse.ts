import { NextResponse } from "next/server";

export function getRouteErrorResponse(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Forbidden";
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 403;

  return NextResponse.json({ error: message }, { status });
}
