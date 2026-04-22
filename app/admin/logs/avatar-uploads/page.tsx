"use client";

import type { AvatarUploadLogRow } from "@/lib/admin/logs";
import GroupedLogPage from "../shared/GroupedLogPage";

export default function AdminAvatarUploadLogsPage() {
  return (
    <GroupedLogPage<AvatarUploadLogRow>
      endpoint="/api/admin/logs/avatar-uploads"
      emptyMessage="No avatar upload logs found."
      getGroupKey={(log) =>
        log.status === "success" ? "Success" : "Failed"
      }
      loadingMessage="Loading avatar upload logs..."
      renderGroupTitle={(groupKey, logs) =>
        `${groupKey} (${logs.length})`
      }
      title="Admin - Avatar Upload Logs"
      renderTitle={(log) => {
        if (log.reason === "cooldown") {
          return `${log.status.toUpperCase()} - Cooldown Blocked`;
        }

        if (log.reason === "missing_file") {
          return `${log.status.toUpperCase()} - Missing File`;
        }

        return `${log.status.toUpperCase()} - Avatar Upload`;
      }}
    />
  );
}
