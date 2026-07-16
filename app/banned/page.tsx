export default async function BannedPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const code = (await searchParams).code;
  const isDiscordRestriction = code === "DISCORD_BANNED";

  return (
    <div className="min-h-screen flex items-center justify-center bg-black px-6">
      <div className="text-center max-w-xl">
        <h1 className="text-4xl md:text-5xl mb-6 text-orange-500 font-[Permanent_Marker]">
          Account restricted
        </h1>

        <p className="text-white/80 text-lg mb-4">
          Your account has been restricted from participating.
        </p>

        <p className="text-white/60 text-sm">
          {isDiscordRestriction
            ? "Discord access must be restored there first. A later rejoin and waiting period are required before signing in again."
            : "This account is not currently eligible to sign in."}
        </p>
      </div>
    </div>
  );
}
