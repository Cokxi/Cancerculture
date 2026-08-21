import Image from "next/image";
import type { PublicDonationOrganization } from "@/lib/organizations/types";

function providerLabel(organization: PublicDonationOrganization) {
  if (organization.providerStatus === "available") return null;
  return organization.providerStatus === "unavailable"
    ? "Currently unavailable for new selections"
    : "Provider availability is being verified";
}

export default function CharitiesContent({
  organizations,
}: {
  organizations: readonly PublicDonationOrganization[];
}) {
  return (
    <div className="w-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-6 pb-16 pt-6">
        <h1 className="mb-8 text-center font-['Permanent_Marker'] text-4xl tracking-wide text-[var(--orange-main)] md:text-5xl">
          Charities
        </h1>

        {organizations.map((organization) => {
          const availability = providerLabel(organization);
          return (
            <article
              key={organization.publicKey}
              className="flex flex-col gap-6 rounded-3xl bg-yellow-star p-6"
            >
              <h2 className="text-center font-['Permanent_Marker'] text-2xl text-[var(--orange-main)]">
                {organization.displayName}
              </h2>
              <div className="grid gap-6 sm:grid-cols-[12rem_1fr] sm:items-center">
                <div className="relative mx-auto aspect-[5/4] w-48 overflow-hidden rounded-2xl border-2 border-[var(--orange-main)] bg-black">
                  <Image
                    src={organization.logoUrl}
                    alt={`${organization.displayName} organization logo`}
                    fill
                    sizes="192px"
                    className="object-contain"
                  />
                </div>
                <div className="flex flex-col gap-4">
                  <p className="leading-7 text-white">
                    {organization.description}
                  </p>
                  {availability ? (
                    <p className="rounded-lg bg-black/10 px-3 py-2 text-sm font-semibold text-black/70">
                      {availability}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-semibold">
                    <a
                      href={organization.officialWebsiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--orange-main)] underline underline-offset-4"
                    >
                      Official website
                    </a>
                    {organization.givingBlockUrl ? (
                      <a
                        href={organization.givingBlockUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--orange-main)] underline underline-offset-4"
                      >
                        The Giving Block
                      </a>
                    ) : null}
                    {organization.officialSocialUrl ? (
                      <a
                        href={organization.officialSocialUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--orange-main)] underline underline-offset-4"
                      >
                        Official social
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
