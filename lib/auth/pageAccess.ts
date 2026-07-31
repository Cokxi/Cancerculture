import { requireAdmin } from "@/lib/auth/guards";
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
