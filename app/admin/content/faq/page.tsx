import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import { getFaqContentForAdmin } from "@/lib/content/faq/data.server";
import FaqEditor from "./FaqEditor";

export const dynamic = "force-dynamic";

export default async function FaqContentAdminPage() {
  await requireTeamCapabilityPage("faq.manage", "/admin/content/faq");
  const state = await getFaqContentForAdmin();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-orange-400">FAQ Content</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
          Edit and preview FAQ changes locally. The single Save &amp; Publish
          action validates the complete document and makes one immutable
          revision public immediately. No server draft is stored.
        </p>
      </header>

      <FaqEditor state={state} requestId={crypto.randomUUID()} />
    </div>
  );
}
