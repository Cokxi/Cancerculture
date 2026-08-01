import Link from "next/link";
import type { UserFlagCase } from "@/lib/admin/userFlagCases";

export default function UserFlagHistoryDisclosure({
  flagCases,
  userLabel,
}: {
  flagCases: readonly UserFlagCase[];
  userLabel: string;
}) {
  if (flagCases.length === 0) {
    return <span style={{ fontSize: 12, opacity: 0.55 }}>None</span>;
  }

  return (
    <details data-user-flag-history style={{ fontSize: 12, minWidth: 180 }}>
      <summary
        aria-label={`Show flag case history for ${userLabel}`}
        style={{ cursor: "pointer", fontWeight: 600 }}
      >
        Flag case history ({flagCases.length})
      </summary>
      <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
        {flagCases.map((flagCase) => (
          <article
            key={flagCase.caseId}
            style={{
              border: "1px solid #333",
              borderRadius: 6,
              padding: "8px 10px",
            }}
          >
            <Link
              href={`/admin/flags/${flagCase.caseId}`}
              style={{ textDecoration: "underline", textUnderlineOffset: 3 }}
            >
              {flagCase.status} ·{" "}
              {flagCase.category ?? "legacy category unavailable"}
            </Link>
            <div style={{ marginTop: 4 }}>
              {flagCase.reason ?? "Legacy reason unavailable"}
            </div>
            <div style={{ marginTop: 3, opacity: 0.7 }}>
              {flagCase.events.length} history event(s)
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}
