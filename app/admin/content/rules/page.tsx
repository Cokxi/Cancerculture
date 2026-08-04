import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getRulesContentForAdmin } from "@/lib/content/rules/data.server";
import RulesEditor from "./RulesEditor";

export const dynamic = "force-dynamic";

export default async function RulesContentAdminPage() {
  await requireTeamCapabilityPage("rules.manage", "/admin/content/rules");
  const state = await getRulesContentForAdmin();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-orange-400">
          Rules Content
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
          Edit a versioned draft, preview it, and publish it with an explicit
          Rules-acceptance decision. Published content changes immediately
          without a Website redeploy.
        </p>
      </header>

      <RulesEditor
        state={state}
        saveRequestId={crypto.randomUUID()}
        publishRequestId={crypto.randomUUID()}
      />
    </div>
  );
}
