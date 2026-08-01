"use client";

import GroupedLogPage from "../shared/GroupedLogPage";
import type { UploadLogRow } from "@/lib/admin/logs";

export default function AdminUploadLogsPage() {
  return (
    <GroupedLogPage<UploadLogRow>
      endpoint="/api/admin/logs/uploads"
      emptyMessage="No upload logs found."
      loadingMessage="Loading upload logs..."
      title="Admin - Upload Logs"
      renderTitle={(log) =>
        log.submission_id
          ? `${log.status.toUpperCase()} - Submission #${log.submission_id}`
          : log.status.toUpperCase()
      }
    />
  );
}
