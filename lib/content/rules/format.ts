const RULES_UPDATED_AT_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export function formatRulesUpdatedAt(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid Rules update timestamp");
  }

  return RULES_UPDATED_AT_FORMATTER.format(date);
}
