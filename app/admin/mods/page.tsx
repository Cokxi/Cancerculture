import { redirect } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/pageAccess";

export const dynamic = "force-dynamic";

export default async function AdminModsPage() {
  await requireAdminPage("/admin/mods");
  redirect("/admin/team/roles");
}
