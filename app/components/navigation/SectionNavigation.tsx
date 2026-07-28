type SectionNavigationItem = {
  id: string;
  title: string;
};

export default function SectionNavigation({
  ariaLabel,
  sections,
}: {
  ariaLabel: string;
  sections: readonly SectionNavigationItem[];
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className="flex max-w-full flex-wrap gap-3 rounded-[20px] border border-[rgba(255,232,196,0.3)] bg-[linear-gradient(180deg,rgba(255,156,76,0.95),rgba(239,104,38,0.92))] p-3 shadow-[0_10px_25px_rgba(0,0,0,0.25)] backdrop-blur-md"
    >
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="max-w-full cursor-pointer rounded-full border border-[rgba(255,196,112,0.4)] bg-[#140803] px-4 py-2 text-center text-sm font-medium text-[#ffb86b] outline-none transition-[background-color,color,box-shadow] hover:bg-[#1f0d05] hover:text-[#ffc27a] hover:shadow-[0_0_12px_rgba(255,196,112,0.35)] focus-visible:ring-2 focus-visible:ring-[#ffd08a] focus-visible:ring-offset-2 focus-visible:ring-offset-[#ef6826] active:bg-[#2a1007] active:text-[#ffd08a]"
        >
          {section.title}
        </a>
      ))}
    </nav>
  );
}
