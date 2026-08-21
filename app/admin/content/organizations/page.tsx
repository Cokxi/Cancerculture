import { requireTeamCapabilityPage } from "@/lib/auth/pageAccess";
import Image from "next/image";
import { getDonationOrganizationManagement } from "@/lib/organizations/data.server";
import {
  reviewOtherOrganizationAction,
  saveOrganizationDraftAction,
  transitionOrganizationAction,
} from "./actions";

export const dynamic = "force-dynamic";

type Revision = {
  revision_number: number;
  selector_name: string;
  display_name: string;
  description: string;
  display_order: number;
  official_website_url: string;
  giving_block_url: string | null;
  official_social_url: string | null;
  provider_status: "available" | "unavailable" | "unverified";
  selectable: boolean;
  legacy_logo_url: string | null;
};

type Organization = {
  publicKey: string;
  state: "draft" | "active" | "archived";
  stateVersion: number;
  draft: Revision | null;
  published: Revision | null;
  hasManagedDraftLogo: boolean;
  hasManagedPublishedLogo: boolean;
};

type OtherReference = {
  submissionId: number;
  sourceType: "other" | "legacy";
  originalName: string;
  originalWebsiteUrl: string | null;
  effectiveVersion: number;
  effectiveState: "verified" | "pending" | "quarantined";
  effectiveName: string;
  effectiveWebsiteUrl: string | null;
};

function noticeText(notice: string | undefined, error: string | undefined) {
  if (error === "permission") return "Your organization-management permission is no longer active.";
  if (error === "conflict") return "The record changed. Review the current version and try again.";
  if (error === "invalid") return "The submitted organization data is invalid.";
  if (error) return "Organization management is temporarily unavailable.";
  if (notice === "draft-saved") return "Versioned organization draft saved.";
  if (notice === "organization-updated") return "Organization state updated.";
  if (notice === "reference-reviewed") return "Other reference reviewed and recorded.";
  return null;
}

function textValue(value: string | null | undefined) {
  return value ?? "";
}

function OrganizationForm({ organization }: { organization?: Organization }) {
  const revision = organization?.draft ?? organization?.published ?? null;
  const isNew = !organization;
  return (
    <form
      action={saveOrganizationDraftAction}
      encType="multipart/form-data"
      className="grid gap-4 rounded-2xl border border-white/10 bg-black/30 p-5 md:grid-cols-2"
    >
      <input type="hidden" name="request_id" value={crypto.randomUUID()} />
      <input
        type="hidden"
        name="expected_state_version"
        value={organization?.stateVersion ?? 0}
      />
      <label className="grid gap-1 text-sm">
        Stable public key
        <input
          name="public_key"
          required
          readOnly={!isNew}
          defaultValue={organization?.publicKey}
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          className="rounded-lg bg-white px-3 py-2 text-black read-only:opacity-60"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Display order
        <input
          name="display_order"
          type="number"
          min="1"
          max="10000"
          required
          defaultValue={revision?.display_order ?? 100}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Selector name
        <input
          name="selector_name"
          required
          maxLength={120}
          defaultValue={revision?.selector_name}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Overlay display name
        <input
          name="display_name"
          required
          maxLength={160}
          defaultValue={revision?.display_name}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm md:col-span-2">
        Public description
        <textarea
          name="description"
          required
          minLength={20}
          maxLength={1200}
          rows={4}
          defaultValue={revision?.description}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Official HTTPS website
        <input
          name="official_website_url"
          type="url"
          required
          maxLength={600}
          defaultValue={revision?.official_website_url}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Giving Block URL (optional)
        <input
          name="giving_block_url"
          type="url"
          maxLength={600}
          defaultValue={textValue(revision?.giving_block_url)}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Official social URL (optional)
        <input
          name="official_social_url"
          type="url"
          maxLength={600}
          defaultValue={textValue(revision?.official_social_url)}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Provider availability
        <select
          name="provider_status"
          defaultValue={revision?.provider_status ?? "unverified"}
          className="rounded-lg bg-white px-3 py-2 text-black"
        >
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
          <option value="unverified">Unverified</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm md:col-span-2">
        Managed logo {isNew ? "(required)" : "(optional replacement)"}
        <input
          name="logo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          required={isNew}
          className="rounded-lg border border-white/20 px-3 py-2"
        />
        <span className="text-xs text-white/50">
          Static JPEG, PNG, or WebP; max 4 MB. The server removes metadata and stores a normalized WebP.
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm md:col-span-2">
        <input
          name="selectable"
          type="checkbox"
          defaultChecked={revision?.selectable ?? false}
        />
        Available in the Upload selector (requires provider status Available)
      </label>
      <button className="rounded-xl bg-orange-500 px-4 py-2 font-semibold text-black md:col-span-2">
        Save versioned draft
      </button>
    </form>
  );
}

function OrganizationCard({ organization }: { organization: Organization }) {
  const preview = organization.draft ?? organization.published;
  return (
    <article className="space-y-5 rounded-3xl border border-white/15 bg-white/5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-orange-300">
            {preview?.display_name ?? organization.publicKey}
          </h2>
          <p className="text-xs text-white/50">
            {organization.publicKey} · {organization.state} · version {organization.stateVersion}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {organization.draft ? (
            <form action={transitionOrganizationAction}>
              <input type="hidden" name="request_id" value={crypto.randomUUID()} />
              <input type="hidden" name="operation" value="publish" />
              <input type="hidden" name="public_key" value={organization.publicKey} />
              <input type="hidden" name="expected_state_version" value={organization.stateVersion} />
              <button className="rounded-lg bg-green-500 px-3 py-2 text-sm font-semibold text-black">
                Publish / activate draft
              </button>
            </form>
          ) : null}
          <form action={transitionOrganizationAction} className="flex gap-2">
            <input type="hidden" name="request_id" value={crypto.randomUUID()} />
            <input type="hidden" name="operation" value="archive" />
            <input type="hidden" name="public_key" value={organization.publicKey} />
            <input type="hidden" name="expected_state_version" value={organization.stateVersion} />
            <input
              name="reason"
              required
              minLength={3}
              maxLength={500}
              placeholder="Archive reason"
              className="w-40 rounded-lg bg-white px-2 py-1 text-sm text-black"
            />
            <button className="rounded-lg border border-red-400 px-3 py-2 text-sm text-red-200">
              Archive
            </button>
          </form>
        </div>
      </div>
      {preview ? (
        <section className="rounded-2xl bg-yellow-star p-4 text-black">
          <p className="text-xs font-semibold uppercase tracking-wide text-black/50">
            Draft preview · order {preview.display_order} · {preview.provider_status}
          </p>
          <h3 className="mt-2 text-lg font-semibold">{preview.display_name}</h3>
          <div className="relative mt-3 aspect-[5/4] w-40 overflow-hidden rounded-xl border border-black/20 bg-black">
            <Image
              src={
                preview.legacy_logo_url ??
                `/api/admin/donation-organizations/${organization.publicKey}/draft-logo`
              }
              alt={`${preview.display_name} draft logo`}
              fill
              sizes="160px"
              className="object-contain"
            />
          </div>
          <p className="mt-2 text-sm leading-6">{preview.description}</p>
          <p className="mt-2 break-all text-xs">{preview.official_website_url}</p>
        </section>
      ) : null}
      <OrganizationForm organization={organization} />
    </article>
  );
}

function OtherReferenceCard({ reference }: { reference: OtherReference }) {
  return (
    <article className="rounded-2xl border border-white/10 bg-black/30 p-5">
      <h3 className="font-semibold text-orange-300">
        Submission {reference.submissionId} · {reference.effectiveState}
      </h3>
      <p className="mt-1 text-sm text-white/70">
        Immutable original: {reference.originalName}
        {reference.originalWebsiteUrl ? ` · ${reference.originalWebsiteUrl}` : " · no historical URL"}
      </p>
      <form action={reviewOtherOrganizationAction} className="mt-4 grid gap-3 md:grid-cols-2">
        <input type="hidden" name="request_id" value={crypto.randomUUID()} />
        <input type="hidden" name="submission_id" value={reference.submissionId} />
        <input type="hidden" name="expected_version" value={reference.effectiveVersion} />
        <input
          name="name"
          required
          maxLength={120}
          defaultValue={reference.effectiveName}
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
        <input
          name="website_url"
          type="url"
          maxLength={600}
          defaultValue={textValue(reference.effectiveWebsiteUrl ?? reference.originalWebsiteUrl)}
          placeholder="Official public HTTPS URL"
          className="rounded-lg bg-white px-3 py-2 text-black"
        />
        <input
          name="reason"
          required
          minLength={3}
          maxLength={500}
          placeholder="Review reason"
          className="rounded-lg bg-white px-3 py-2 text-black md:col-span-2"
        />
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <button name="operation" value="verify" className="rounded-lg bg-green-500 px-3 py-2 text-sm text-black">
            Verify
          </button>
          <button name="operation" value="correct" className="rounded-lg bg-orange-400 px-3 py-2 text-sm text-black">
            Save correction
          </button>
          <button name="operation" value="quarantine" formNoValidate className="rounded-lg border border-red-400 px-3 py-2 text-sm text-red-200">
            Quarantine
          </button>
          <button name="operation" value="create_candidate" className="rounded-lg border border-blue-300 px-3 py-2 text-sm text-blue-100">
            Create deduplicated draft candidate
          </button>
        </div>
      </form>
    </article>
  );
}

export default async function DonationOrganizationsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const authorization = await requireTeamCapabilityPage(
    "donation_organizations.manage",
    "/admin/content/organizations"
  );
  const [state, query] = await Promise.all([
    getDonationOrganizationManagement(authorization.discord_user_id),
    searchParams,
  ]);
  const organizations = state.organizations as Organization[];
  const otherReferences = state.otherReferences as OtherReference[];
  const notice = noticeText(query.notice, query.error);

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <header>
        <h1 className="text-3xl font-semibold text-orange-400">
          Donation Organizations
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">
          Draft, preview, publish, sort, deactivate, and archive the server-authoritative Upload and overlay catalog. Publication updates the Website without a deployment; historical Submission choices remain frozen.
        </p>
      </header>
      {notice ? (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm ${query.error ? "bg-red-950 text-red-200" : "bg-green-950 text-green-200"}`}>
          {notice}
        </p>
      ) : null}

      <details className="rounded-3xl border border-white/15 p-6">
        <summary className="cursor-pointer text-xl font-semibold text-orange-300">
          Add organization draft
        </summary>
        <div className="mt-5"><OrganizationForm /></div>
      </details>

      <section className="space-y-6">
        <h2 className="text-2xl font-semibold">Catalog</h2>
        {organizations.map((organization) => (
          <OrganizationCard key={organization.publicKey} organization={organization} />
        ))}
      </section>

      <section className="space-y-5">
        <div>
          <h2 className="text-2xl font-semibold">Other review</h2>
          <p className="mt-1 text-sm text-white/60">
            Original data is immutable. Pending or quarantined entries have no public or payout link. A candidate creates only a draft and never publishes automatically.
          </p>
        </div>
        {otherReferences.length === 0 ? (
          <p className="text-sm text-white/50">No Other or historical references require display.</p>
        ) : otherReferences.map((reference) => (
          <OtherReferenceCard key={reference.submissionId} reference={reference} />
        ))}
      </section>
    </div>
  );
}
