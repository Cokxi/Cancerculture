export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  context: { params: Promise<{ slug: string }> }
) {
  void req;
  await context.params;
  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_BASE_URL}/?invite=retired`
  );
}
