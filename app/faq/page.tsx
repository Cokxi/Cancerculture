"use client";

import TwoColumnInfoLayout from "@/app/components/shared/TwoColumnInfoLayout";
import { FAQ_CONTENT } from "@/app/content/faq";

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-orange-background overflow-x-hidden">
      
      <TwoColumnInfoLayout
        leftTitle={FAQ_CONTENT.left.title}
        leftText={FAQ_CONTENT.left.text}
        rightTitle={FAQ_CONTENT.right.title}
        rightText={FAQ_CONTENT.right.text}
        showCenterCell
      />
    </div>
  );
}
