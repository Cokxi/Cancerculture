export const HOMEPAGE_INFO_BLOCK_LIMITS = {
  title: 120,
  body: 5000,
  linkLabel: 100,
  linkUrl: 2048,
  displayOrderMin: 0,
  displayOrderMax: 100_000,
} as const;

export type HomepageInfoBlockValues = {
  title: string | null;
  body: string;
  displayOrder: number;
  isActive: boolean;
  linkLabel: string | null;
  linkUrl: string | null;
};

type HomepageInfoBlockInput = {
  title?: unknown;
  body?: unknown;
  displayOrder?: unknown;
  isActive?: unknown;
  linkLabel?: unknown;
  linkUrl?: unknown;
};

function normalizeText(value: unknown) {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

function normalizeOptionalText(
  value: unknown,
  field: string,
  maximumLength: number
) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return null;
  }

  if (normalized.length > maximumLength) {
    throw new Error(`${field} must be ${maximumLength} characters or fewer`);
  }

  return normalized;
}

function parseDisplayOrder(value: unknown) {
  const normalized =
    typeof value === "number" ? String(value) : normalizeText(value);

  if (!/^\d+$/.test(normalized)) {
    throw new Error("Display order must be a whole number");
  }

  const displayOrder = Number(normalized);

  if (
    !Number.isSafeInteger(displayOrder) ||
    displayOrder < HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMin ||
    displayOrder > HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMax
  ) {
    throw new Error(
      `Display order must be between ${HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMin} and ${HOMEPAGE_INFO_BLOCK_LIMITS.displayOrderMax}`
    );
  }

  return displayOrder;
}

export function normalizeHomepageInfoBlockLinkUrl(value: string) {
  if (
    value.length > HOMEPAGE_INFO_BLOCK_LIMITS.linkUrl ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    value.includes("\\")
  ) {
    throw new Error("Link URL is invalid");
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    const parsed = new URL(value, "https://cancerculture.invalid");

    if (parsed.origin !== "https://cancerculture.invalid") {
      throw new Error("Link URL is invalid");
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Link URL must be an internal path or HTTPS URL");
  }

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Link URL must be an internal path or HTTPS URL");
  }

  return parsed.toString();
}

export function validateHomepageInfoBlockInput(
  input: HomepageInfoBlockInput
): HomepageInfoBlockValues {
  const title = normalizeOptionalText(
    input.title,
    "Title",
    HOMEPAGE_INFO_BLOCK_LIMITS.title
  );
  const body = normalizeText(input.body);

  if (!body) {
    throw new Error("Body is required");
  }

  if (body.length > HOMEPAGE_INFO_BLOCK_LIMITS.body) {
    throw new Error(
      `Body must be ${HOMEPAGE_INFO_BLOCK_LIMITS.body} characters or fewer`
    );
  }

  const linkLabel = normalizeOptionalText(
    input.linkLabel,
    "Link label",
    HOMEPAGE_INFO_BLOCK_LIMITS.linkLabel
  );
  const rawLinkUrl = normalizeOptionalText(
    input.linkUrl,
    "Link URL",
    HOMEPAGE_INFO_BLOCK_LIMITS.linkUrl
  );

  if (Boolean(linkLabel) !== Boolean(rawLinkUrl)) {
    throw new Error("Link label and Link URL must be provided together");
  }

  return {
    title,
    body,
    displayOrder: parseDisplayOrder(input.displayOrder),
    isActive:
      input.isActive === true ||
      input.isActive === "true" ||
      input.isActive === "on",
    linkLabel,
    linkUrl: rawLinkUrl
      ? normalizeHomepageInfoBlockLinkUrl(rawLinkUrl)
      : null,
  };
}

export function validateHomepageInfoBlockFormData(formData: FormData) {
  return validateHomepageInfoBlockInput({
    title: formData.get("title"),
    body: formData.get("body"),
    displayOrder: formData.get("display_order"),
    isActive: formData.get("is_active"),
    linkLabel: formData.get("link_label"),
    linkUrl: formData.get("link_url"),
  });
}
