"use client";

import AboutTextBox from "@/app/components/AboutTextBox";
import AboutCenterCell from "@/app/components/AboutCenterCell";

type Props = {
  leftTitle: string;
  leftText: string;
  rightTitle: string;
  rightText: string;
  showCenterCell?: boolean;
};

export default function TwoColumnInfoLayout({
  leftTitle,
  leftText,
  rightTitle,
  rightText,
  showCenterCell = false,
}: Props) {
  return (
   <div className="relative max-w-6xl mx-auto px-6 pt-24 pb-64">
  <div
    className="
      grid
      grid-cols-1
      lg:grid-cols-[minmax(320px,380px)_220px_minmax(320px,380px)]
      gap-20
      items-start
      justify-center
    "
  >
    <AboutTextBox title={leftTitle} text={leftText} />

    <div aria-hidden className="h-full" />

    <AboutTextBox title={rightTitle} text={rightText} />
  </div>

  {showCenterCell && <AboutCenterCell />}
</div>

  );
}
