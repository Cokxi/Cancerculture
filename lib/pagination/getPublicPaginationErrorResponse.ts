import "server-only";
import { NextResponse } from "next/server";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { PublicPaginationCursorError } from "./publicPaginationCursor";

export function getPublicPaginationErrorResponse(
  error: unknown
) {
  if (error instanceof PublicPaginationCursorError) {
    return NextResponse.json(
      { error: "INVALID_CURSOR" },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const response = getRouteErrorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
