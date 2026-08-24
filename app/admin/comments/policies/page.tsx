export const dynamic = "force-dynamic";

import { requireAdminPage } from "@/lib/auth/pageAccess";
import { requireSession } from "@/lib/auth/requireSession";
import { getCommunityCommentPolicyManagement } from "@/lib/comments/commentPolicyManagement.server";
import CommentPolicyManager from "./CommentPolicyManager";

export default async function CommentPolicyManagementPage() {
  await requireAdminPage("/admin/comments/policies");
  const session = await requireSession();
  const state = await getCommunityCommentPolicyManagement(session.session_id);

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300/75">
          Owner only
        </p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          Comment Safety Controls
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
          Manage the global Comment release gate and private versioned abuse
          policies. Every save is atomic, version-checked and permanently audited.
        </p>
      </header>
      <CommentPolicyManager initialState={state} />
    </div>
  );
}
