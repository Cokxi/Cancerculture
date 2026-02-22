"use client";

import PageWrapper from "@/app/components/ui/PageWrapper";
import TwoColumnInfoLayout from "@/app/components/shared/TwoColumnInfoLayout";
import { FAQ_CONTENT } from "@/app/content/faq";

export default function FAQPage() {
  return (
    <PageWrapper>
      <TwoColumnInfoLayout
        leftTitle={FAQ_CONTENT.left.title}
        leftText={FAQ_CONTENT.left.text}
        rightTitle={FAQ_CONTENT.right.title}
        rightText={FAQ_CONTENT.right.text}
        showCenterCell
      />
    </PageWrapper>
  );
}