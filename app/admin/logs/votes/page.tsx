"use client";

import type { VoteLogRow } from "@/lib/admin/logs";
import GroupedLogPage from "../shared/GroupedLogPage";

export default function AdminVoteLogsPage() {
  return (
    <GroupedLogPage<VoteLogRow>
      endpoint="/api/admin/logs/votes"
      emptyMessage="No vote logs found."
      loadingMessage="Loading vote logs..."
      title="Admin - Vote Logs"
      renderTitle={(log) =>
        log.submission_id
          ? `${log.status.toUpperCase()} - Submission #${log.submission_id}`
          : log.status.toUpperCase()
      }
    />
  );
}
