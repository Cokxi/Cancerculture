import { requireAdmin, requireModOrAdmin } from "@/lib/auth/guards";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";
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

export async function requireModOrAdminPage(_statePath?: string) {
  void _statePath;
  try {
    return await requireModOrAdmin();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);

    if (destination) {
      redirect(destination);
    }

    throw error;
  }
}
