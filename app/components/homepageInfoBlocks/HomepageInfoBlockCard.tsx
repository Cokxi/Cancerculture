import Link from "next/link";
import type { HomepageInfoBlock } from "@/lib/homepageInfoBlocks/types";

export default function HomepageInfoBlockCard({
  block,
}: {
  block: HomepageInfoBlock;
}) {
  const isExternalLink = block.linkUrl?.startsWith("https://") ?? false;

  return (
    <article className="orange-info-box orange-info-box--compact orange-info-box--home">
      <div className="mx-auto max-w-[520px] text-center">
        {block.title ? (
          <h3 className="orange-box-title">{block.title}</h3>
        ) : null}

        <p className="whitespace-pre-wrap">{block.body}</p>

        {block.linkLabel && block.linkUrl ? (
          isExternalLink ? (
            <a
              href={block.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="orange-box-link inline-flex cursor-pointer rounded-sm font-semibold underline underline-offset-4 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white active:text-white/75"
            >
              {block.linkLabel}
            </a>
          ) : (
            <Link
              href={block.linkUrl}
              className="orange-box-link inline-flex cursor-pointer rounded-sm font-semibold underline underline-offset-4 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white active:text-white/75"
            >
              {block.linkLabel}
            </Link>
          )
        ) : null}
      </div>
    </article>
  );
}
