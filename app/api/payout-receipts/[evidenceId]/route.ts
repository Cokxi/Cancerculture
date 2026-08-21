export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { requireUuid } from "@/lib/payouts/amount";
import { getPublicPayoutReceiptSource } from "@/lib/payouts/service.server";
import { r2 } from "@/lib/r2";

export async function GET(_request: Request, context: { params: Promise<{ evidenceId: string }> }) {
  try {
    const bucket = process.env.R2_PAYOUT_EVIDENCE_BUCKET_NAME?.trim();
    if (!bucket) throw new Error("PAYOUT_RECEIPT_UNAVAILABLE");
    const { evidenceId } = await context.params;
    const source = await getPublicPayoutReceiptSource(requireUuid(evidenceId));
    const key = typeof source?.r2Key === "string" ? source.r2Key : null;
    const byteSize = typeof source?.byteSize === "number" ? source.byteSize : null;
    if (!key || !byteSize || byteSize <= 0 || byteSize > 3_145_728) throw new Error("PAYOUT_RECEIPT_UNAVAILABLE");
    const object = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes || bytes.byteLength !== byteSize) throw new Error("PAYOUT_RECEIPT_UNAVAILABLE");
    return new Response(bytes.buffer as ArrayBuffer, { headers: { "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": "image/webp", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  }
}
