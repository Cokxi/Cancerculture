import { NextResponse } from "next/server";
import {
  getAuthErrorCode,
  getAuthErrorStatus,
} from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";

export async function GET() {
  try {
    await requireSession();
    return NextResponse.json({ verified: true });
  } catch (error) {
    const status = getAuthErrorStatus(error) ?? 500;
    return NextResponse.json(
      {
        verified: false,
        error:
          getAuthErrorCode(error)?.split(":")[0] ??
          "AUTHENTICATION_UNAVAILABLE",
      },
      { status }
    );
  }
}
