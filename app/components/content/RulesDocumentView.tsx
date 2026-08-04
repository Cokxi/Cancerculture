import SectionNavigation from "@/app/components/navigation/SectionNavigation";
import type {
  RulesContentDocument,
  RulesContentSection,
} from "@/lib/content/rules/types";
import { formatRulesUpdatedAt } from "@/lib/content/rules/format";

function RuleBlock({
  section,
  tone,
}: {
  section: RulesContentSection;
  tone: "primary" | "accent";
}) {
  const toneClasses =
    tone === "accent"
      ? "border-[rgba(255,228,180,0.5)] bg-[linear-gradient(180deg,rgba(255,197,108,0.94),rgba(255,148,64,0.92))] shadow-[0_16px_34px_rgba(0,0,0,0.18)]"
      : "border-[rgba(255,232,196,0.56)] bg-[linear-gradient(180deg,rgba(255,156,76,0.95),rgba(239,104,38,0.93))] shadow-[0_16px_34px_rgba(0,0,0,0.2)]";

  return (
    <section
      id={section.id}
      className={`scroll-mt-24 rounded-[24px] border p-6 backdrop-blur-sm sm:scroll-mt-28 sm:p-8 ${toneClasses}`}
    >
      <h2 className="font-['Permanent_Marker'] text-2xl tracking-[0.04em] text-[#2b1208] sm:text-[1.8rem]">
        {section.title}
      </h2>

      <div className="mt-4 space-y-4 text-base leading-7 text-[rgba(43,18,8,0.9)] sm:text-[1.05rem]">
        {section.paragraphs.map((paragraph, index) => (
          <p key={`${section.id}-paragraph-${index}`}>{paragraph}</p>
        ))}

        {section.bullets.length > 0 ? (
          <ul className="space-y-3 pl-5">
            {section.bullets.map((bullet, index) => (
              <li
                key={`${section.id}-bullet-${index}`}
                className="list-disc marker:text-[#fff4b0]"
              >
                {bullet}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export default function RulesDocumentView({
  document,
  rulesUpdatedAt,
}: {
  document: RulesContentDocument;
  rulesUpdatedAt?: string;
}) {
  return (
    <div className="flex w-full flex-col gap-8">
      <section className="relative overflow-hidden rounded-[30px] border border-[rgba(255,220,180,0.38)] bg-[linear-gradient(145deg,rgba(255,137,58,0.94),rgba(226,88,29,0.94))] px-6 py-8 text-[#1a0b05] shadow-[0_18px_45px_rgba(0,0,0,0.38)] sm:px-9 sm:py-10">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,240,200,0.28),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(0,0,0,0.18),transparent_45%)]" />

        <div className="relative">
          <p className="font-['Permanent_Marker'] text-sm uppercase tracking-[0.2em] text-[rgba(26,11,5,0.72)]">
            {document.eyebrow}
          </p>
          <h1 className="mt-3 font-['Permanent_Marker'] text-4xl leading-tight text-[#140803] sm:text-5xl">
            {document.heading}
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-[rgba(26,11,5,0.85)] sm:text-[1.05rem]">
            {document.introduction}
          </p>
        </div>
      </section>

      <SectionNavigation
        ariaLabel="Rules sections"
        sections={document.sections}
      />

      <section className="rounded-[24px] border border-[rgba(255,232,196,0.56)] bg-[linear-gradient(180deg,rgba(255,196,112,0.95),rgba(255,147,67,0.92))] p-5 text-[rgba(43,18,8,0.9)] shadow-[0_12px_30px_rgba(0,0,0,0.14)]">
        <p className="font-['Permanent_Marker'] text-lg text-[#2b1208]">
          {document.noticeTitle}
        </p>
        <p className="mt-2 text-sm leading-6">{document.noticeBody}</p>
      </section>

      <section className="space-y-5">
        {document.sections.map((section, index) => (
          <RuleBlock
            key={section.id}
            section={section}
            tone={index % 2 === 0 ? "primary" : "accent"}
          />
        ))}
      </section>

      {rulesUpdatedAt ? (
        <footer className="border-t border-[rgba(255,232,196,0.3)] pt-5 text-center text-sm text-[rgba(255,238,214,0.72)]">
          Rules last updated{" "}
          <time dateTime={rulesUpdatedAt}>
            {formatRulesUpdatedAt(rulesUpdatedAt)}
          </time>
        </footer>
      ) : null}
    </div>
  );
}
