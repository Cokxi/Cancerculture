export const dynamic = "force-dynamic";

import CommunityCommentModerationPanel from "@/app/components/comments/CommunityCommentModerationPanel";
import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";

export default async function CommunityCommentModerationPage() {
  await requireTeamCapabilityPage("community.comments.moderate", "/admin/moderation/comments");
  return (
    <section className="space-y-6">
      <header>
        <h1 className="font-['Permanent_Marker'] text-4xl text-[var(--orange-main)]">Comment Moderation</h1>
        <p className="mt-2 max-w-3xl text-white/65">Remove or restore one current Comment by its public ID. Every action requires the current version and an internal reason.</p>
      </header>
      <CommunityCommentModerationPanel />
    </section>
  );
}
