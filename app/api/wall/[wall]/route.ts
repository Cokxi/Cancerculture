export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";
import {
  getPublicWallPage,
  type PublicWall,
} from "@/lib/walls/getPublicWallPage";

export async function GET(
  req: Request,
  context: { params: Promise<{ wall: string }> }
) {
  try {
    const { wall: rawWall } = await context.params;

    if (rawWall !== "fame" && rawWall !== "shame") {
      return NextResponse.json(
        { error: "INVALID_WALL" },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const wall: PublicWall = rawWall;
    const cursor = new URL(req.url).searchParams.get("cursor");
    const page = await getPublicWallPage({ cursor, wall });

    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}

