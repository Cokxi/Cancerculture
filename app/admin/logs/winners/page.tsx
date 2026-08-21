export const dynamic = "force-dynamic";

import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { redirect } from "next/navigation";

export default async function WinnerLogsPage() {
  await requireTeamCapabilityPage("winners.payouts.view", "/admin/logs/winners");
  redirect("/admin/payouts");
}
