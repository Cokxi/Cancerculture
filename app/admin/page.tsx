
import Link from "next/link";
import { redirect } from "next/navigation";
import { getResolvedTeamAreaNavigation } from "@/lib/admin/teamAreaNavigation.server";
import { getTeamPageAccessRedirect } from "@/lib/auth/pageAccessDecision";

export default async function AdminIndexPage() {
  let navigation;

  try {
    navigation = await getResolvedTeamAreaNavigation();
  } catch (error) {
    const destination = getTeamPageAccessRedirect(error);
    if (destination) {
      redirect(destination);
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-300/70">
          Internal workspace
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">Team Area</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/60">
          Open the tools available to your current team role.
        </p>
      </header>

      {navigation.length === 0 ? (
        <section className="mt-8 rounded-xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="font-semibold">No areas assigned</h2>
          <p className="mt-2 text-sm text-white/60">
            Your team membership is active, but no Team Area tools are
            available for your current permissions.
          </p>
        </section>
      ) : (
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {navigation.map((category) => (
            <section
              key={category.id}
              className="rounded-xl border border-white/10 bg-white/[0.035] p-4"
            >
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-white/55">
                {category.title}
              </h2>
              <ul className="mt-3 divide-y divide-white/[0.08]">
                {category.items.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      href={entry.href!}
                      className="group block rounded-lg px-2 py-3 outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-orange-300"
                    >
                      <span className="flex items-center justify-between gap-3 font-medium text-white/85 group-hover:text-orange-200">
                        {entry.title}
                        <span aria-hidden="true" className="text-white/35">
                          →
                        </span>
                      </span>
                      {entry.description ? (
                        <span className="mt-1 block text-sm leading-5 text-white/50">
                          {entry.description}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
