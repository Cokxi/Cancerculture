import { requireAdmin, requireModOrAdmin } from "@/lib/auth/guards";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { redirect } from "next/navigation";

export async function requireAdminPage(statePath?: string) {
  try {
    return await requireAdmin();
  } catch (error) {
    const status = getAuthErrorStatus(error);

    if (status === 401 && statePath) {
      redirect(`/api/auth/discord/login?state=${statePath}`);
    }

    if (status === 401 || status === 403) {
      redirect("/403");
    }

    throw error;
  }
}

export async function requireModOrAdminPage(statePath?: string) {
  try {
    return await requireModOrAdmin();
  } catch (error) {
    const status = getAuthErrorStatus(error);

    if (status === 401 && statePath) {
      redirect(`/api/auth/discord/login?state=${statePath}`);
    }

    if (status === 401 || status === 403) {
      redirect("/403");
    }

    throw error;
  }
}
