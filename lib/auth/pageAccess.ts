import { requireAdmin } from "@/lib/auth/guards";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
import { requireDynamicTeamCapability } from "@/lib/auth/teamAuthorization";
import type { RegisteredTeamCapabilityKey } from "@/lib/auth/teamCapabilityRegistry";
import { redirect } from "next/navigation";

export async function requireAdminPage(_statePath?: string) {
  void _statePath;
  try {
    return await requireAdmin();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }
}

export async function requireTeamCapabilityPage(
  capability: RegisteredTeamCapabilityKey,
  _statePath?: string
) {
  void _statePath;
  try {
    return await requireDynamicTeamCapability(capability);
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }
}
