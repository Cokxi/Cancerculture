import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <div className="max-w-xl text-center">
        <p className="text-sm uppercase tracking-[0.2em] text-white/50">
          403
        </p>
        <h1 className="mt-3 text-4xl font-[Permanent_Marker] text-orange-500 md:text-5xl">
          Access denied
        </h1>
        <p className="mt-5 text-white/70">
          This account does not currently have access to this area.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex rounded-full border border-orange-400/40 bg-orange-500/10 px-5 py-2 text-sm text-orange-200 transition hover:bg-orange-500/20"
        >
          Return home
        </Link>
      </div>
    </main>
  );
}
