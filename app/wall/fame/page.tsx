import FameGrid from "./FameGrid";
import AnimatedCell from "./AnimatedCell";
import PageWrapper from "@/app/components/ui/PageWrapper";
import { getPublicWallPage } from "@/lib/walls/getPublicWallPage";
import { getTurnstileClientSiteKey } from "@/lib/turnstile/config.server";

export const dynamic = "force-dynamic";

export default async function WallOfFamePage() {
  const initialPage = await getPublicWallPage({
    wall: "fame",
  });

  return (
    <PageWrapper>
      <div className="p-4 sm:p-6 text-white/90">
        <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">
          <AnimatedCell />
          <span>Wall of Fame</span>
        </h1>

        <FameGrid
          initialPage={initialPage}
          turnstileSiteKey={getTurnstileClientSiteKey()}
        />
      </div>
    </PageWrapper>
  );
}
