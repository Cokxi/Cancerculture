import { requireAdminPage } from "@/lib/auth/pageAccess";
import { supabaseAdmin } from "@/lib/db/admin";
import {
  createCoinLaunchAction,
  updateCoinLaunchAction,
} from "./actions";

export const dynamic = "force-dynamic";

type LaunchRow = {
  id: number;
  chain: string;
  platform: string;
  token_symbol: string | null;
  contract_address: string | null;
  launch_url: string | null;
  explorer_url: string | null;
  is_active: boolean;
  is_primary: boolean;
  display_order: number;
};

function LaunchFields({ launch }: { launch?: LaunchRow }) {
  const inputClassName =
    "rounded border border-white/15 bg-black/40 px-3 py-2 text-white outline-none focus:border-orange-400";

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Chain
        <input
          className={inputClassName}
          name="chain"
          defaultValue={launch?.chain ?? ""}
          maxLength={500}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Platform
        <input
          className={inputClassName}
          name="platform"
          defaultValue={launch?.platform ?? ""}
          maxLength={500}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Token Symbol
        <input
          className={inputClassName}
          name="token_symbol"
          defaultValue={launch?.token_symbol ?? ""}
          maxLength={500}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Display Order
        <input
          className={inputClassName}
          name="display_order"
          type="number"
          min="0"
          max="100000"
          defaultValue={launch?.display_order ?? 100}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm md:col-span-2">
        Contract Address
        <input
          className={`${inputClassName} font-mono text-xs`}
          name="contract_address"
          defaultValue={launch?.contract_address ?? ""}
          maxLength={500}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm md:col-span-2">
        Launch URL
        <input
          className={inputClassName}
          name="launch_url"
          type="url"
          defaultValue={launch?.launch_url ?? ""}
          maxLength={500}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm md:col-span-2">
        Explorer URL
        <input
          className={inputClassName}
          name="explorer_url"
          type="url"
          defaultValue={launch?.explorer_url ?? ""}
          maxLength={500}
        />
      </label>
      <div className="flex flex-wrap gap-6 md:col-span-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            name="is_active"
            type="checkbox"
            defaultChecked={launch?.is_active ?? false}
          />
          Active
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            name="is_primary"
            type="checkbox"
            defaultChecked={launch?.is_primary ?? false}
          />
          Primary
        </label>
      </div>
    </div>
  );
}

export default async function CoinLaunchesAdminPage() {
  await requireAdminPage("/admin/coin-launches");

  const { data, error } = await supabaseAdmin
    .from("coin_launches")
    .select(
      "id, chain, platform, token_symbol, contract_address, launch_url, explorer_url, is_active, is_primary, display_order"
    )
    .order("is_primary", { ascending: false })
    .order("display_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    console.error("[COIN_LAUNCHES] admin query failed", error);
    throw new Error("Failed to load coin launch links");
  }

  const launches = (data ?? []) as LaunchRow[];

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-orange-400">
          Coin Launch Links
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Manage the active contract and public launch links shown on Home.
        </p>
      </header>

      <section className="rounded-xl border border-orange-500/25 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">Add Coin Launch</h2>
        <form action={createCoinLaunchAction} className="space-y-4">
          <LaunchFields />
          <button
            className="rounded bg-orange-600 px-4 py-2 font-semibold text-white transition hover:bg-orange-500"
            type="submit"
          >
            Create Coin Launch
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Existing Links</h2>
        {launches.length === 0 ? (
          <p className="text-sm text-white/55">No coin launch links yet.</p>
        ) : null}

        {launches.map((launch) => (
          <details
            key={launch.id}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-5"
          >
            <summary className="cursor-pointer font-semibold text-orange-300">
              {launch.token_symbol || "Coin"} - {launch.platform} - {launch.chain}
              {launch.is_primary ? " - Primary" : ""}
              {launch.is_active ? " - Active" : " - Inactive"}
            </summary>
            <form action={updateCoinLaunchAction} className="mt-5 space-y-4">
              <input name="id" type="hidden" value={launch.id} />
              <LaunchFields launch={launch} />
              <button
                className="rounded bg-white/10 px-4 py-2 font-semibold transition hover:bg-white/20"
                type="submit"
              >
                Save Changes
              </button>
            </form>
          </details>
        ))}
      </section>
    </div>
  );
}
