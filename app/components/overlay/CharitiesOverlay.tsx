"use client";

import BaseOverlay from "./BaseOverlay";
import { useOverlay } from "./OverlayProvider";
import CharitiesContent from "@/app/components/charities/CharitiesContent";
import type { PublicDonationOrganization } from "@/lib/organizations/types";

export default function CharitiesOverlay({
  organizations,
}: {
  organizations: readonly PublicDonationOrganization[];
}) {
  const { closeOverlay } = useOverlay();

  return (
    <BaseOverlay onClose={closeOverlay}>
      <CharitiesContent organizations={organizations} />
    </BaseOverlay>
  );
}
