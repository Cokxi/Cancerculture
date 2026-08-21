export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireUuid } from "@/lib/payouts/amount";
import { r2 } from "@/lib/r2";

export async function GET(_request: Request, context: { params: Promise<{ evidenceId: string }> }) {
  try {
    const authorization = await requireDynamicTeamCapability("winners.manage_payouts");
    const bucket = process.env.R2_PAYOUT_EVIDENCE_BUCKET_NAME?.trim();
    if (!bucket) throw new Error("PAYOUT_PRIVATE_STORAGE_UNAVAILABLE");
    const { evidenceId } = await context.params;
    const { data, error } = await supabaseAdmin.rpc("get_payout_private_evidence_source", { p_actor_discord_user_id: authorization.discord_user_id, p_evidence_public_id: requireUuid(evidenceId) });
    const source = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (error || typeof source.r2Key !== "string" || typeof source.byteSize !== "number" || source.byteSize <= 0 || source.byteSize > 3_000_000) throw new Error("PAYOUT_EVIDENCE_UNAVAILABLE");
    const object = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: source.r2Key }));
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes || bytes.byteLength !== source.byteSize) throw new Error("PAYOUT_EVIDENCE_UNAVAILABLE");
    return new Response(bytes.buffer as ArrayBuffer, { headers: { "Cache-Control": "private, no-store, max-age=0", "Content-Type": "image/webp", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store, max-age=0" } });
  }
}
