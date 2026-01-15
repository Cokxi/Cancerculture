import { cookies } from "next/headers";
import DesktopUpload from "@/app/components/upload/DesktopUpload";
import MobileUpload from "@/app/components/upload/MobileUpload";

export default async function UploadPage() {
  const cookieStore = await cookies();
  const isDiscordAuthed = Boolean(
    cookieStore.get("discord_user_id")?.value
  );

  return (
    <div className="min-h-screen bg-orange-background">
      {/* =========================
          DESKTOP (md+)
         ========================= */}
      <div className="hidden md:block">
        <DesktopUpload showSupportLink={isDiscordAuthed} />
      </div>

      {/* =========================
          MOBILE (< md)
         ========================= */}
      <div className="block md:hidden">
        <MobileUpload showSupportLink={isDiscordAuthed} />
      </div>
    </div>
  );
}
