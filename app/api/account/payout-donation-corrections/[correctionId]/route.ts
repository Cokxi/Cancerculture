export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import { parsePositiveInteger, requireUuid } from "@/lib/payouts/amount";
import { PayoutError, submitOwnPayoutDonationCorrection } from "@/lib/payouts/service.server";
import { enforceRouteMutationGate } from "@/lib/writeGate.server";

export async function POST(request: Request, context: { params: Promise<{ correctionId: string }> }) {
  const gate = enforceRouteMutationGate();
  if (gate) return gate;
  try {
    const { correctionId } = await context.params;
    const body = await request.json();
    const sourceType = body?.sourceType === "catalog" || body?.sourceType === "other" ? body.sourceType : null;
    if (!sourceType) throw new Error("Choose a charity or enter another charity.");
    const result = await submitOwnPayoutDonationCorrection(await requireSession(), {
      correctionPublicId: requireUuid(correctionId),
      requestId: requireUuid(body?.requestId),
      expectedVersion: parsePositiveInteger(String(body?.expectedVersion ?? "")),
      sourceType,
      organizationPublicKey: sourceType === "catalog" && typeof body?.organizationPublicKey === "string" ? body.organizationPublicKey.trim() : null,
      otherName: sourceType === "other" && typeof body?.otherName === "string" ? body.otherName.trim() : null,
      otherWebsiteUrl: sourceType === "other" && typeof body?.otherWebsiteUrl === "string" ? body.otherWebsiteUrl.trim() : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const status = error instanceof PayoutError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "The charity choice could not be saved." }, { status, headers: { "Cache-Control": "private, no-store" } });
  }
}
