import ShameGrid from "./ShameGrid";
import AnimatedCellShame from "./AnimatedCellShame";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicWallPage } from "@/lib/walls/getPublicWallPage";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";

export const dynamic = "force-dynamic";

export default async function WallOfShamePage() {
  const initialPage = await getPublicWallPage({
    wall: "shame",
  });

  return (
    <PageWrapper>
      <div className="p-4 text-white/90 sm:p-6">
        <h1 className="mb-8 flex items-center justify-center gap-2 text-2xl font-[Permanent_Marker] text-[var(--orange-dark)] sm:text-3xl">
          <AnimatedCellShame />
          <span>Wall of Shame</span>
        </h1>

        <ShameGrid
          initialPage={initialPage}
          turnstileSiteKey={getTurnstileClientSiteKey()}
        />
      </div>
    </PageWrapper>
  );
}
