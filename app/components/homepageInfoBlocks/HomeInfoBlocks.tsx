import HomepageInfoBlockCard from "./HomepageInfoBlockCard";
import type { HomepageInfoBlock } from "@/lib/homepageInfoBlocks/types";

export default async function HomeInfoBlocks({
  infoBlocksPromise,
}: {
  infoBlocksPromise: Promise<HomepageInfoBlock[]>;
}) {
  let blocks: HomepageInfoBlock[];

  try {
    blocks = await infoBlocksPromise;
  } catch {
    console.error("[HOMEPAGE_INFO_BLOCKS] home rendering unavailable");
    return null;
  }

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="home-info-block-list">
      {blocks.map((block) => (
        <HomepageInfoBlockCard key={block.id} block={block} />
      ))}
    </div>
  );
}
