export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  DISCORD_MEMBERSHIP_SYNC_MAX_BODY_BYTES,
  DiscordMembershipSyncAuthError,
  verifyDiscordMembershipSyncRequest,
} from "@/lib/auth/discordMembershipSyncAuth";
import { supabaseAdmin } from "@/lib/db/admin";

type JsonObject = Record<string, unknown>;

const LIVE_EVENT_RPCS = {
  member_joined: "apply_discord_member_join_v2",
  member_removed: "apply_discord_member_remove",
  ban_added: "apply_discord_ban",
  ban_removed: "apply_discord_unban",
} as const;

type ParsedRecord = {
  discordUserId: string;
  discordUsername: string;
  joinedAt?: string;
  membershipObservedAt?: string;
};

type OptionalTimestamp =
  | { valid: true; value: string | null }
  | { valid: false; value: null };

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const EVENT_TYPES = new Set([
  ...Object.keys(LIVE_EVENT_RPCS),
  "snapshot_started",
  "snapshot_members_chunk",
  "snapshot_bans_chunk",
  "snapshot_finalize",
  "reconciliation_failed",
]);

function response(
  body: JsonObject,
  status: number
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
}

function revalidatePublicSubmissionSurfaces() {
  revalidatePath("/");
  revalidatePath("/submissions");
  revalidatePath("/admin/moderation/legal-review");
  revalidatePath("/cycle-history");
  revalidatePath("/profile/[publicProfileId]", "page");
  revalidatePath("/wall/fame");
  revalidatePath("/wall/shame");
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getString(
  payload: JsonObject,
  key: string,
  pattern: RegExp,
  maxLength: number
) {
  const value =
    typeof payload[key] === "string" ? payload[key].trim() : "";
  return value.length <= maxLength && pattern.test(value) ? value : null;
}

function getObservedAt(payload: JsonObject) {
  const value =
    typeof payload.observedAt === "string"
      ? payload.observedAt
      : "";
  const timestamp = Date.parse(value);

  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 5 * 60 * 1000 ||
    timestamp < Date.now() - 24 * 60 * 60 * 1000
  ) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function getOptionalTimestamp(
  payload: JsonObject,
  key: string,
  latestAllowedAt: string
): OptionalTimestamp {
  if (!(key in payload)) {
    return { valid: true, value: null };
  }

  if (typeof payload[key] !== "string") {
    return { valid: false, value: null };
  }

  const match = ISO_TIMESTAMP_PATTERN.exec(payload[key]);
  if (!match) {
    return { valid: false, value: null };
  }

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] =
    match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { valid: false, value: null };
  }

  const timestamp = Date.parse(payload[key]);
  const latestAllowedTimestamp = Date.parse(latestAllowedAt);

  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(latestAllowedTimestamp) ||
    timestamp > latestAllowedTimestamp
  ) {
    return { valid: false, value: null };
  }

  return {
    valid: true,
    value: new Date(timestamp).toISOString(),
  };
}

function parseRecords(
  payload: JsonObject,
  eventType: "snapshot_members_chunk" | "snapshot_bans_chunk",
  eventObservedAt: string
) {
  if (!Array.isArray(payload.records) || payload.records.length > 250) {
    return null;
  }

  const records: Array<ParsedRecord | null> = payload.records.map((record) => {
    if (!isObject(record)) {
      return null;
    }

    const discordUserId = getString(
      record,
      "discordUserId",
      /^\d{5,32}$/,
      32
    );
    const discordUsername = getString(
      record,
      "discordUsername",
      /^.{1,100}$/u,
      100
    );

    if (!discordUserId || !discordUsername) {
      return null;
    }

    const parsedRecord: ParsedRecord = {
      discordUserId,
      discordUsername,
    };

    if (eventType === "snapshot_members_chunk") {
      const membershipObservedAt = getOptionalTimestamp(
        record,
        "membershipObservedAt",
        eventObservedAt
      );

      if (!membershipObservedAt.valid) {
        return null;
      }

      const joinedAt = membershipObservedAt.value
        ? getOptionalTimestamp(
            record,
            "joinedAt",
            membershipObservedAt.value
          )
        : "joinedAt" in record
          ? { valid: false as const, value: null }
          : { valid: true as const, value: null };

      if (!joinedAt.valid) {
        return null;
      }

      if (membershipObservedAt.value) {
        parsedRecord.membershipObservedAt = membershipObservedAt.value;
      }

      if (joinedAt.value) {
        parsedRecord.joinedAt = joinedAt.value;
      }
    }

    return parsedRecord;
  });

  return records.every((record): record is ParsedRecord => record !== null)
    ? records
    : null;
}

function normalizeRpcResult(data: unknown) {
  return isObject(data) ? data : {};
}

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > DISCORD_MEMBERSHIP_SYNC_MAX_BODY_BYTES
  ) {
    return response({ error: "PAYLOAD_TOO_LARGE" }, 413);
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return response({ error: "INVALID_REQUEST" }, 400);
  }

  if (Buffer.byteLength(body, "utf8") > DISCORD_MEMBERSHIP_SYNC_MAX_BODY_BYTES) {
    return response({ error: "PAYLOAD_TOO_LARGE" }, 413);
  }

  let auth;
  try {
    auth = verifyDiscordMembershipSyncRequest({
      method: req.method,
      path: new URL(req.url).pathname,
      timestamp: req.headers.get("x-cc-timestamp"),
      eventId: req.headers.get("x-cc-event-id"),
      signature: req.headers.get("x-cc-signature"),
      body,
    });
  } catch (error) {
    if (error instanceof DiscordMembershipSyncAuthError) {
      return response({ error: error.code }, error.status);
    }

    return response({ error: "SYNC_NOT_CONFIGURED" }, 503);
  }

  let payload: JsonObject;
  try {
    const parsed = JSON.parse(body);
    if (!isObject(parsed)) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }
    payload = parsed;
  } catch {
    return response({ error: "INVALID_PAYLOAD" }, 400);
  }

  const eventType =
    typeof payload.eventType === "string" ? payload.eventType : "";
  const bodyEventId =
    typeof payload.eventId === "string" ? payload.eventId : "";
  const guildId =
    typeof payload.guildId === "string" ? payload.guildId : "";
  const observedAt = getObservedAt(payload);

  if (
    !EVENT_TYPES.has(eventType) ||
    bodyEventId !== auth.eventId ||
    guildId !== auth.guildId ||
    !observedAt
  ) {
    return response({ error: "INVALID_PAYLOAD" }, 400);
  }

  let rpcName: string;
  let rpcParameters: JsonObject;

  if (eventType in LIVE_EVENT_RPCS) {
    const discordUserId = getString(
      payload,
      "discordUserId",
      /^\d{5,32}$/,
      32
    );
    const discordUsername = getString(
      payload,
      "discordUsername",
      /^.{1,100}$/u,
      100
    );

    if (!discordUserId || !discordUsername) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    const joinedAt =
      eventType === "member_joined"
        ? getOptionalTimestamp(payload, "joinedAt", observedAt)
        : { valid: true as const, value: null };

    if (!joinedAt.valid) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    rpcName = LIVE_EVENT_RPCS[eventType as keyof typeof LIVE_EVENT_RPCS];
    rpcParameters = {
      p_event_id: auth.eventId,
      p_observed_at: observedAt,
      p_payload_sha256: auth.payloadSha256,
      p_discord_user_id: discordUserId,
      p_discord_username: discordUsername,
    };

    if (eventType === "member_joined") {
      rpcParameters.p_joined_at = joinedAt.value;
    }
  } else if (eventType === "snapshot_started") {
    const snapshotId = getString(
      payload,
      "snapshotId",
      /^[0-9a-f-]{36}$/i,
      36
    );
    const expectedMemberCount = payload.expectedMemberCount;
    const expectedBanCount = payload.expectedBanCount;

    if (
      !snapshotId ||
      !Number.isInteger(expectedMemberCount) ||
      !Number.isInteger(expectedBanCount) ||
      Number(expectedMemberCount) < 0 ||
      Number(expectedBanCount) < 0 ||
      Number(expectedMemberCount) > 1_000_000 ||
      Number(expectedBanCount) > 1_000_000
    ) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    rpcName = "begin_discord_reconciliation_snapshot";
    rpcParameters = {
      p_event_id: auth.eventId,
      p_observed_at: observedAt,
      p_payload_sha256: auth.payloadSha256,
      p_snapshot_id: snapshotId,
      p_expected_member_count: expectedMemberCount,
      p_expected_ban_count: expectedBanCount,
    };
  } else if (
    eventType === "snapshot_members_chunk" ||
    eventType === "snapshot_bans_chunk"
  ) {
    const snapshotId = getString(
      payload,
      "snapshotId",
      /^[0-9a-f-]{36}$/i,
      36
    );
    const records = parseRecords(payload, eventType, observedAt);

    if (!snapshotId || !records) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    rpcName = "append_discord_reconciliation_chunk";
    rpcParameters = {
      p_event_id: auth.eventId,
      p_event_type: eventType,
      p_observed_at: observedAt,
      p_payload_sha256: auth.payloadSha256,
      p_snapshot_id: snapshotId,
      p_records: records,
    };
  } else if (eventType === "snapshot_finalize") {
    const snapshotId = getString(
      payload,
      "snapshotId",
      /^[0-9a-f-]{36}$/i,
      36
    );
    if (!snapshotId) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    rpcName = "finalize_discord_reconciliation_snapshot";
    rpcParameters = {
      p_event_id: auth.eventId,
      p_observed_at: observedAt,
      p_payload_sha256: auth.payloadSha256,
      p_snapshot_id: snapshotId,
    };
  } else {
    const errorCode = getString(
      payload,
      "errorCode",
      /^[A-Z0-9_]{1,80}$/,
      80
    );
    if (!errorCode) {
      return response({ error: "INVALID_PAYLOAD" }, 400);
    }

    rpcName = "record_discord_reconciliation_failure";
    rpcParameters = {
      p_event_id: auth.eventId,
      p_observed_at: observedAt,
      p_payload_sha256: auth.payloadSha256,
      p_error_code: errorCode,
    };
  }

  const { data, error } = await supabaseAdmin.rpc(
    rpcName,
    rpcParameters
  );

  if (error) {
    console.error("[DISCORD_SYNC] database operation failed", {
      code: error.code,
      eventType,
    });
    return response({ error: "SYNC_DEPENDENCY_UNAVAILABLE" }, 503);
  }

  const result = normalizeRpcResult(data);
  const outcome =
    typeof result.outcome === "string" ? result.outcome : "";

  if (outcome === "replay") {
    return response({ error: "REPLAY" }, 409);
  }

  if (
    outcome === "invalid_request" ||
    outcome === "invalid_event" ||
    outcome === "invalid_record"
  ) {
    return response({ error: "INVALID_PAYLOAD" }, 400);
  }

  if (
    outcome === "snapshot_conflict" ||
    outcome === "snapshot_unavailable" ||
    outcome === "incomplete_snapshot"
  ) {
    return response({ error: "SNAPSHOT_CONFLICT" }, 409);
  }

  if (
    eventType === "ban_added" ||
    eventType === "ban_removed" ||
    eventType === "snapshot_finalize"
  ) {
    revalidatePublicSubmissionSurfaces();
  }

  return response(
    {
      ok: true,
      outcome: outcome || "applied",
    },
    200
  );
}
