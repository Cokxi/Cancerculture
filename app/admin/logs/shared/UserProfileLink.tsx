export default function UserProfileLink({
  discordUserId,
  label,
  publicProfileId,
}: {
  discordUserId: string;
  label: string;
  publicProfileId?: string | null;
}) {
  return (
    <a
      href={
        publicProfileId
          ? `/profile/${publicProfileId}`
          : `/admin/users?focus=${discordUserId}`
      }
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-orange-400 underline decoration-orange-400/40 underline-offset-4 hover:text-orange-300"
    >
      {label}
    </a>
  );
}
