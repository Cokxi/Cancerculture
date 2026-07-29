import HomepageInfoBlockCard from "@/app/components/homepageInfoBlocks/HomepageInfoBlockCard";
import { requireAdminPage } from "@/lib/auth/pageAccess";
import { getHomepageInfoBlocksForAdmin } from "@/lib/homepageInfoBlocks/data.server";
import type { AdminHomepageInfoBlock } from "@/lib/homepageInfoBlocks/types";
import { HOMEPAGE_INFO_BLOCK_LIMITS } from "@/lib/homepageInfoBlocks/validation";
import {
  createHomepageInfoBlockAction,
  setHomepageInfoBlockActiveAction,
  updateHomepageInfoBlockAction,
} from "./actions";
import DeleteHomepageInfoBlockButton from "./DeleteHomepageInfoBlockButton";

export const dynamic = "force-dynamic";

const inputClassName =
  "rounded border border-white/15 bg-black/40 px-3 py-2 text-white outline-none transition-colors focus:border-orange-400 focus-visible:ring-2 focus-visible:ring-orange-300";
const primaryButtonClassName =
  "cursor-pointer rounded bg-orange-600 px-4 py-2 font-semibold text-white outline-none transition-colors hover:bg-orange-500 focus-visible:ring-2 focus-visible:ring-orange-300 active:bg-orange-700";
const secondaryButtonClassName =
  "cursor-pointer rounded bg-white/10 px-4 py-2 font-semibold outline-none transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-orange-300 active:bg-white/5";

function InfoBlockFields({
  block,
}: {
  block?: AdminHomepageInfoBlock;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          className={inputClassName}
          name="title"
          defaultValue={block?.title ?? ""}
          maxLength={HOMEPAGE_INFO_BLOCK_LIMITS.title}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Display Order
        <input
          className={inputClassName}
          name="display_order"
          type="number"
          min={HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMin}
          max={HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMax}
          defaultValue={block?.displayOrder ?? 100}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm md:col-span-2">
        Body
        <textarea
          className={`${inputClassName} min-h-48 resize-y`}
          name="body"
          defaultValue={block?.body ?? ""}
          maxLength={HOMEPAGE_INFO_BLOCK_LIMITS.body}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Link Label
        <input
          className={inputClassName}
          name="link_label"
          defaultValue={block?.linkLabel ?? ""}
          maxLength={HOMEPAGE_INFO_BLOCK_LIMITS.linkLabel}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Link URL
        <input
          className={inputClassName}
          name="link_url"
          defaultValue={block?.linkUrl ?? ""}
          maxLength={HOMEPAGE_INFO_BLOCK_LIMITS.linkUrl}
          placeholder="/rules or https://example.com"
        />
      </label>

      <label className="flex cursor-pointer items-center gap-2 text-sm md:col-span-2">
        <input
          className="cursor-pointer accent-orange-500"
          name="is_active"
          type="checkbox"
          defaultChecked={block?.isActive ?? true}
        />
        Active
      </label>
    </div>
  );
}

function getExcerpt(body: string) {
  const flattened = body.replace(/\s+/g, " ").trim();
  return flattened.length > 160
    ? `${flattened.slice(0, 157)}...`
    : flattened;
}

export default async function HomepageInfoBlocksAdminPage() {
  await requireAdminPage("/admin/homepage-info-blocks");
  const blocks = await getHomepageInfoBlocksForAdmin();
  const activeBlocks = blocks.filter((block) => block.isActive);

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold text-orange-400">
          Homepage Info Boxes
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Manage the ordered public Info cards shown on Home.
        </p>
      </header>

      <section className="rounded-xl border border-orange-500/25 bg-white/5 p-5">
        <h2 className="mb-4 text-lg font-semibold">
          Create Info Box
        </h2>
        <form
          action={createHomepageInfoBlockAction}
          className="space-y-5"
        >
          <InfoBlockFields />
          <button type="submit" className={primaryButtonClassName}>
            Create Info Box
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Existing Info Boxes</h2>
        {blocks.length === 0 ? (
          <p className="text-sm text-white/55">
            No Homepage Info Boxes exist yet.
          </p>
        ) : null}

        {blocks.map((block) => (
          <details
            key={block.id}
            className="rounded-xl border border-white/10 bg-white/[0.04] p-5"
          >
            <summary className="cursor-pointer rounded-sm font-semibold text-orange-300 outline-none transition-colors hover:text-orange-200 focus-visible:ring-2 focus-visible:ring-orange-300 active:text-orange-400">
              {block.title || `Untitled Info Box #${block.id}`} —{" "}
              {block.isActive ? "Active" : "Inactive"} — Order{" "}
              {block.displayOrder} — Edit
            </summary>

            <div className="mt-4 space-y-5">
              <p className="text-sm text-white/60">
                {getExcerpt(block.body)}
              </p>

              <dl className="grid gap-2 text-xs text-white/50 sm:grid-cols-2">
                <div>
                  <dt className="font-semibold text-white/70">Created</dt>
                  <dd>{block.createdAt}</dd>
                  <dd>{block.createdBy ?? "Unknown actor"}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-white/70">Updated</dt>
                  <dd>{block.updatedAt}</dd>
                  <dd>{block.updatedBy ?? "Unknown actor"}</dd>
                </div>
              </dl>

              <form
                action={updateHomepageInfoBlockAction}
                className="space-y-5"
              >
                <input name="id" type="hidden" value={block.id} />
                <InfoBlockFields block={block} />
                <button
                  type="submit"
                  className={secondaryButtonClassName}
                >
                  Save Changes
                </button>
              </form>

              <div className="flex flex-wrap gap-3 border-t border-white/10 pt-4">
                <form action={setHomepageInfoBlockActiveAction}>
                  <input name="id" type="hidden" value={block.id} />
                  <input
                    name="is_active"
                    type="hidden"
                    value={block.isActive ? "false" : "true"}
                  />
                  <button
                    type="submit"
                    className={secondaryButtonClassName}
                  >
                    {block.isActive ? "Deactivate" : "Activate"}
                  </button>
                </form>

                <DeleteHomepageInfoBlockButton blockId={block.id} />
              </div>
            </div>
          </details>
        ))}
      </section>

      <section className="space-y-5 border-t border-white/10 pt-8">
        <header>
          <h2 className="text-lg font-semibold">Public Preview</h2>
          <p className="mt-1 text-sm text-white/55">
            Fresh active records in public display order.
          </p>
        </header>

        {activeBlocks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-white/20 p-5 text-sm text-white/55">
            No active Homepage Info Boxes are currently published.
          </p>
        ) : (
          <div className="flex w-full max-w-[900px] flex-col items-center gap-[clamp(2rem,4vw,3rem)]">
            {activeBlocks.map((block) => (
              <HomepageInfoBlockCard key={block.id} block={block} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
