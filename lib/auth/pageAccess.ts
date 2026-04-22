import { requireAdmin, requireModOrAdmin } from "@/lib/auth/guards";
import { redirect } from "next/navigation";

function getErrorStatus(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  if (error instanceof Response) {
    return error.status;
  }

  return null;
}

export async function requireAdminPage(statePath?: string) {
  try {
    return await requireAdmin();
  } catch (error) {
    if (getErrorStatus(error) === 401 && statePath) {
      redirect(`/api/auth/discord/login?state=${statePath}`);
    }

    redirect("/403");
  }
}

export async function requireModOrAdminPage(statePath?: string) {
  try {
    return await requireModOrAdmin();
  } catch (error) {
    if (getErrorStatus(error) === 401 && statePath) {
      redirect(`/api/auth/discord/login?state=${statePath}`);
    }

    redirect("/403");
  }
}
