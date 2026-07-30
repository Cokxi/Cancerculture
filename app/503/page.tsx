import BackButton from "@/app/components/ui/BackButton";

export default function ServiceUnavailablePage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center text-white">
      <h1 className="text-3xl font-semibold">
        Team access temporarily unavailable
      </h1>
      <p className="mt-4 text-white/70">
        Authorization could not be verified safely. Please try again later.
      </p>
      <div className="mt-8">
        <BackButton href="/" label="Home" />
      </div>
    </main>
  );
}
