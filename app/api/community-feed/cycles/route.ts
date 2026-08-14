export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCommunityFeedCycleCatalogPage } from "@/lib/feed/communityFeedReadModel.server";
import { getPublicPaginationErrorResponse } from "@/lib/pagination/getPublicPaginationErrorResponse";

export async function GET(request: Request) {
  try {
    const cursor = new URL(request.url).searchParams.get("cursor");
    const page = await getCommunityFeedCycleCatalogPage({ cursor });
    return NextResponse.json(page, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return getPublicPaginationErrorResponse(error);
  }
}
