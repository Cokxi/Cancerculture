export default function BannedPage() {
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
          Violation of platform rules (admin decision)
        </p>
      </div>
    </div>
  );
}
