export type DonationOrganizationProviderStatus =
  | "available"
  | "unavailable"
  | "unverified";

export type PublicDonationOrganization = Readonly<{
  publicKey: string;
  selectorName: string;
  displayName: string;
  description: string;
  displayOrder: number;
  officialWebsiteUrl: string;
  givingBlockUrl: string | null;
  officialSocialUrl: string | null;
  providerStatus: DonationOrganizationProviderStatus;
  selectable: boolean;
  logoUrl: string;
  revisionNumber: number;
}>;

export type SubmissionOrganizationSelection =
  | Readonly<{
      sourceType: "catalog";
      publicKey: string;
      otherName: null;
      otherWebsiteUrl: null;
    }>
  | Readonly<{
      sourceType: "other";
      publicKey: null;
      otherName: string;
      otherWebsiteUrl: string;
    }>;

export type DonationOrganizationDraftPayload = Readonly<{
  selectorName: string;
  displayName: string;
  description: string;
  displayOrder: number;
  officialWebsiteUrl: string;
  givingBlockUrl: string | null;
  officialSocialUrl: string | null;
  providerStatus: DonationOrganizationProviderStatus;
  selectable: boolean;
  legacyLogoUrl: string | null;
  logoR2Key: string | null;
}>;
