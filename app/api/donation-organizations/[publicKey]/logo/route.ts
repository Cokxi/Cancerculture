export const runtime = "nodejs";

import { createNeutralCommunityFeedMediaResponse, proxyCommunityFeedMedia } from "@/lib/feed/communityFeedMedia";
import { supabaseAdmin } from "@/lib/db/admin";

const PUBLIC_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export async function GET(
  _request: Request,
  context: { params: Promise<{ publicKey: string }> }
) {
  const { publicKey } = await context.params;
  if (!PUBLIC_KEY_PATTERN.test(publicKey) || publicKey.length > 80) {
    return createNeutralCommunityFeedMediaResponse();
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_donation_organization_logo_source",
    { p_public_key: publicKey }
  );
  if (error || typeof data !== "string") {
    return createNeutralCommunityFeedMediaResponse();
  }
  return proxyCommunityFeedMedia({ storageKey: data });
}
