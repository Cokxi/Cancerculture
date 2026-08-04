import PageWrapper from "@/app/components/ui/PageWrapper";
import FaqDocumentView from "@/app/components/content/FaqDocumentView";
import { getPublishedFaqContent } from "@/lib/content/faq/data.server";

export const dynamic = "force-dynamic";

export default async function FAQPage() {
  const published = await getPublishedFaqContent();

  return (
    <PageWrapper>
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 pb-18 pt-8 sm:px-6 sm:pb-24 sm:pt-12">
        <FaqDocumentView document={published.content} />
      </div>
    </PageWrapper>
  );
}
