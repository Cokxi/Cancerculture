export const runtime = "nodejs";

import { getUploadLogs } from "@/lib/admin/logs";
import { requireModOrAdmin } from "@/lib/auth/guards";
import { getRouteErrorResponse } from "@/lib/http/getRouteErrorResponse";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    await requireModOrAdmin();

    const { data, error } = await getUploadLogs();

    if (error) {
      return NextResponse.json(
        { error: "Failed to load upload logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      logs: data ?? [],
    });
  } catch (error) {
    return getRouteErrorResponse(error);
  }
}
