import "server-only";

import { cache } from "react";
import { getTeamAuthorizationContext } from "@/lib/auth/teamAuthorization";
import { resolveTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation";

export const getResolvedTeamAreaNavigation = cache(async () =>
  resolveTeamAreaNavigation(await getTeamAuthorizationContext())
);

