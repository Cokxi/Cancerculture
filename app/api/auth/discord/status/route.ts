import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";

export async function GET() {
  try {
    await requireSession();
    return NextResponse.json({ verified: true });
  } catch {
    return NextResponse.json({ verified: false });
  }
}
