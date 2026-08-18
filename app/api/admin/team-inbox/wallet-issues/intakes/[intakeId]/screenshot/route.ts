export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { loadWalletIssueScreenshot } from "@/lib/walletIssues/service.server";

export async function GET(_request: Request, context: { params: Promise<{ intakeId: string }> }) {
  try {
    const { intakeId } = await context.params;
    const result = await loadWalletIssueScreenshot(intakeId);
    if (result.outcome !== "found" || typeof result.data !== "string" || result.mime !== "image/webp") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return new NextResponse(Buffer.from(result.data, "base64"), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `inline; filename="wallet-issue-${intakeId}.webp"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 503;
    return NextResponse.json({ error: status === 403 ? "FORBIDDEN" : "UNAVAILABLE" }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
