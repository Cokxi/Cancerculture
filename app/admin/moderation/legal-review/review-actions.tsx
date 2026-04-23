"use client";

type ReviewActionsProps = {
  submissionId: number;
  status: "legal_review" | "removed";
};

export default function ReviewActions({
  submissionId,
  status,
}: ReviewActionsProps) {
  async function updateStatus(nextStatus: "visible" | "removed") {
    const res = await fetch(
      "/api/admin/submissions/public-visibility",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId,
          status: nextStatus,
          reasonCode:
            nextStatus === "visible"
              ? null
              : "manual_review",
          reasonText: null,
        }),
      }
    );

    if (!res.ok) {
      alert("Visibility update failed");
      return;
    }

    window.location.reload();
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {status === "legal_review" ? (
        <button
          type="button"
          onClick={() => updateStatus("removed")}
          className="rounded-full border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          Remove from Public
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => updateStatus("visible")}
        className="rounded-full border border-green-400/40 bg-green-500/10 px-3 py-2 text-xs text-green-200"
      >
        Restore Public
      </button>
    </div>
  );
}
