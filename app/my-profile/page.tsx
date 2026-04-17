import { requireSession } from "@/lib/auth/requireSession";
import { getUserSubmissions } from "@/lib/queries/getUserSubmissions";
import ProfileSections from "./ProfileSections";
import { supabaseServer } from "@/lib/db/server";
import BackButton from "@/app/components/ui/BackButton";
import AvatarUpload from "@/app/components/ui/AvatarUpload";

const formatReason = (r: string) =>
  r
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export default async function MyProfilePage() {
  const session = await requireSession();
  const discord_user_id = session.discord_user_id;
  const { data: userLog } = await supabaseServer
  .from("user_logs")
  .select("first_seen_at, avatar_key, avatar_updated_at, discord_avatar")
  .eq("discord_user_id", discord_user_id)
  .maybeSingle();
  const joinedDate = userLog?.first_seen_at
  ? new Date(userLog.first_seen_at).toLocaleDateString("en-GB")
  : null;

  const avatarKey = userLog?.avatar_key ?? null;

const avatarUrl =
  avatarKey
    ? `${process.env.NEXT_PUBLIC_R2_PUBLIC_URL}/${avatarKey}`
    : userLog?.discord_avatar
    ? `https://cdn.discordapp.com/avatars/${discord_user_id}/${userLog.discord_avatar}.png`
    : null;

  const submissions = await getUserSubmissions(discord_user_id);
  const { data: votes } = await supabaseServer
  .from("votes")
  .select("cycle_id, submission_id, created_at")
  .eq("discord_user_id", discord_user_id)
  .order("cycle_id", { ascending: false });

  const submissionIds = votes?.map(v => v.submission_id) ?? [];

const { data: voteSubmissions } = await supabaseServer
  .from("submissions")
  .select("id, image_url, r2_key")
  .in("id", submissionIds);

const submissionMap = new Map(
  voteSubmissions?.map(s => [String(s.id), s]) ?? []
);


  const currentCycleId = submissions[0]?.cycle_id;

const currentSubmission = currentCycleId
  ? submissions.find((s: any) => s.cycle_id === currentCycleId)
  : null;



  return (
  <>
    <BackButton href="/" label="Back" />

    <div className="max-w-2xl mx-auto px-4 py-10 text-white space-y-10">
      
      <div className="flex flex-col items-center text-center space-y-4">
        
        <div className="w-24 h-24 rounded-full overflow-hidden bg-orange-500/20 flex items-center justify-center text-2xl">
  {avatarUrl ? (
      <img
        src={avatarUrl}
        className="w-full h-full object-cover"
        alt="User Avatar"
      />
    ) : (
      "👤"
    )}
  </div>

  <AvatarUpload />
       

         <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl mb-8 font-[Permanent_Marker] text-[var(--orange-dark)]">
          My Profile
        </h1>

        <p className="text-sm text-gray-300">
  Joined: {joinedDate ?? "—"}
</p>
      </div>
     
      <div className="space-y-4">
       <h2 className="flex items-center justify-center gap-2 text-xl sm:text-2xl mb-6 font-[Permanent_Marker] text-[var(--orange-dark)]">
  Current Cycle
</h2>

        <div className="border-2 border-[var(--orange-dark)]/60 bg-black/40 p-4 rounded-lg flex flex-col items-center">
  {currentSubmission?.image_url ? (
    <img
      src={currentSubmission.image_url}
      className="w-48 h-48 object-cover mb-3 rounded"
    />
  ) : (
    <div className="w-48 h-48 bg-orange-200/20 rounded mb-3 flex items-center justify-center">
      🚫
    </div>
  )}

  <p className="text-sm text-gray-300">
    Votes: {currentSubmission?.vote_count ?? "—"}
  </p>

  <p className="text-sm text-gray-300">
  Rank:{" "}
  {currentSubmission?.rank === 1 && "🥇 "}
  {currentSubmission?.rank === 2 && "🥈 "}
  {currentSubmission?.rank === 3 && "🥉 "}
  {currentSubmission?.rank
    ? `${currentSubmission.rank} / ${currentSubmission.total}${
        currentSubmission.tie_count > 1
          ? ` (${currentSubmission.tie_count} tied)`
          : ""
      }`
    : "—"}
</p>
<div className="mt-2 text-xs">
  {currentSubmission?.is_disqualified ? (
    <div className="text-red-400">
      🔴 Disqualified

      {currentSubmission.disqualification_reason_code && (
        <div className="text-red-300 text-[11px] mt-1">
          {formatReason(
            currentSubmission.disqualification_reason_code
          )}
        </div>
      )}

      {currentSubmission.disqualification_reason_text && (
        <div className="text-red-300 text-[11px]">
          {currentSubmission.disqualification_reason_text}
        </div>
      )}

      {currentSubmission.disqualified_by_discord_username && (
        <div className="text-red-300 text-[11px]">
          by{" "}
          {
            currentSubmission.disqualified_by_discord_username
          }
        </div>
      )}
    </div>
  ) : (
    <div className="text-green-400">
      🟢 Active
    </div>
  )}
</div>
</div>
      </div>

    
      <ProfileSections
  submissions={submissions}
  votes={votes}
  submissionMap={submissionMap}
/>

     
        </div>
  </>
  );
}