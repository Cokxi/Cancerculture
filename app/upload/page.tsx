import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSession } from "@/lib/auth/requireSession";
import PageWrapper from "@/app/components/ui/PageWrapper";
import DesktopUpload from "@/app/components/upload/DesktopUpload";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  let discordUserId: string;

  /* 🔐 Session-required Page */
  try {
    const session = await requireSession();
    discordUserId = session.discord_user_id;
  } catch {
    redirect("/api/auth/discord/login?state=/upload");
  }

    /* 🚫 BAN CHECK */
  const { data: userLog } = await supabaseAdmin
    .from("user_logs")
    .select("is_banned, ban_reason")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (userLog?.is_banned) {
    const reason = encodeURIComponent(
      userLog.ban_reason ?? "You are banned."
    );
    redirect(`/banned?reason=${reason}`);
  }


  /* 🔁 Aktiven Cycle holen */
  const { data: activeCycle } = await supabaseAdmin
    .from("voting_cycles")
    .select("id")
    .eq("status", "active")
    .maybeSingle();

  

  /* 🔁 Check: schon hochgeladen? (Discord-only) */
  let alreadyUploaded = false;

  if (activeCycle) {
    const { data: existingSubmission } =
      await supabaseAdmin
        .from("submissions")
        .select("id")
        .eq("cycle_id", activeCycle.id)
        .eq("discord_user_id", discordUserId)
        .maybeSingle();

    alreadyUploaded = Boolean(existingSubmission);
  }

  const showSupportLink = true;

  return (
    <PageWrapper>
          {alreadyUploaded ? (
  <>
     
   

    <DesktopUpload
      showSupportLink={showSupportLink}
      forceSuccessState
    />
  </>
) : (
  <DesktopUpload showSupportLink={showSupportLink} />
)}
    </PageWrapper>
  );
}
