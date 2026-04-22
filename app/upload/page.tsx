import PageWrapper from "@/app/components/ui/PageWrapper";
import DesktopUpload from "@/app/components/upload/DesktopUpload";
import { requireSession } from "@/lib/auth/requireSession";
import { getUploadEligibility } from "@/lib/upload/getUploadEligibility";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  let discordUserId: string;

  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    redirect("/api/auth/discord/login?state=/upload");
  }

  const uploadEligibility = await getUploadEligibility({
    discordUserId,
  });

  if (uploadEligibility.isBanned) {
    const reason = encodeURIComponent(
      uploadEligibility.banReason ?? "You are banned."
    );
    redirect(`/banned?reason=${reason}`);
  }

  return (
    <PageWrapper>
      <DesktopUpload
        showSupportLink
        forceSuccessState={uploadEligibility.alreadyUploaded}
      />
    </PageWrapper>
  );
}
