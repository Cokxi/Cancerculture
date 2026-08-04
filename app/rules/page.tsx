import PageWrapper from "@/app/components/ui/PageWrapper";
import RulesDocumentView from "@/app/components/content/RulesDocumentView";
import { getPublishedRulesContent } from "@/lib/content/rules/data.server";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const published = await getPublishedRulesContent();

  return (
    <PageWrapper>
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 pb-18 pt-8 sm:px-6 sm:pb-24 sm:pt-12">
        <RulesDocumentView
          document={published.revision.content}
          rulesUpdatedAt={published.rulesUpdatedAt}
        />
      </div>
    </PageWrapper>
  );
}
