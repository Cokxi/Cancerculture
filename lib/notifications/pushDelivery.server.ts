import "server-only";

import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { supabaseAdmin } from "@/lib/db/admin";
import { decryptPushSubscription } from "@/lib/notifications/pushCrypto.server";
import { buildGenericPushPayload } from "@/lib/notifications/pushPayload";

type ClaimedJob = {
  jobId: number;
  leaseToken: string;
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
  categoryKey: string;
  eventType: string;
  notificationId: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function deliveryConfig() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  if (
    !/^[A-Za-z0-9_-]{40,256}$/u.test(publicKey) ||
    !/^[A-Za-z0-9_-]{20,256}$/u.test(privateKey) ||
    !/^(mailto:|https:\/\/).{3,240}$/u.test(subject)
  ) return null;
  return { publicKey, privateKey, subject };
}

async function rpc(functionName: string, parameters: object) {
  const { data, error } = await supabaseAdmin.rpc(functionName, parameters);
  if (error) {
    console.error("[PUSH] delivery RPC failed", { functionName, code: error.code });
    throw new Error("PUSH_DELIVERY_DATABASE_UNAVAILABLE");
  }
  return data;
}

function parseJobs(value: unknown): ClaimedJob[] {
  const items = record(value).items;
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const job = record(raw);
    if (
      !Number.isSafeInteger(job.jobId) ||
      typeof job.leaseToken !== "string" ||
      typeof job.ciphertext !== "string" ||
      typeof job.nonce !== "string" ||
      typeof job.tag !== "string" ||
      !Number.isSafeInteger(job.keyVersion) ||
      typeof job.categoryKey !== "string" ||
      typeof job.eventType !== "string" ||
      typeof job.notificationId !== "string"
    ) throw new Error("PUSH_CLAIM_RESPONSE_INVALID");
    return job as unknown as ClaimedJob;
  });
}

function parseSubscription(value: string): webpush.PushSubscription {
  const candidate = JSON.parse(value) as webpush.PushSubscription;
  if (
    typeof candidate.endpoint !== "string" ||
    !candidate.endpoint.startsWith("https://") ||
    typeof candidate.keys?.p256dh !== "string" ||
    typeof candidate.keys?.auth !== "string"
  ) throw new Error("PUSH_SUBSCRIPTION_INVALID");
  return candidate;
}

function classifyDeliveryError(error: unknown) {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    && typeof error.statusCode === "number" ? error.statusCode : null;
  if (statusCode === 404 || statusCode === 410) {
    return { code: `provider_${statusCode}`, retryable: false, subscriptionInvalid: true };
  }
  if (statusCode === 408 || statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
    return { code: statusCode ? `provider_${statusCode}` : "provider_retryable", retryable: true, subscriptionInvalid: false };
  }
  return { code: statusCode ? `provider_${statusCode}` : "delivery_failed", retryable: false, subscriptionInvalid: false };
}

export async function processDueNotificationWork({
  broadcastLimit = 100,
  deliveryLimit = 20,
}: {
  broadcastLimit?: number;
  deliveryLimit?: number;
} = {}) {
  const config = deliveryConfig();
  if (!config) throw new Error("PUSH_DELIVERY_CONFIGURATION_UNAVAILABLE");
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const broadcast = record(await rpc("process_notification_broadcast_batch", {
    p_limit: broadcastLimit,
  }));
  const workerToken = randomUUID();
  const jobs = parseJobs(await rpc("claim_due_push_deliveries", {
    p_worker_token: workerToken,
    p_limit: deliveryLimit,
  }));
  let delivered = 0;
  let retried = 0;
  let failedPermanent = 0;
  for (const job of jobs) {
    try {
      const subscription = parseSubscription(decryptPushSubscription({
        ciphertext: job.ciphertext,
        nonce: job.nonce,
        tag: job.tag,
        keyVersion: job.keyVersion,
      }));
      const payload = buildGenericPushPayload({
        eventType: job.eventType,
        categoryKey: job.categoryKey,
        notificationId: job.notificationId,
      });
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 300,
        urgency: "normal",
      });
      await rpc("complete_push_delivery", {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
      });
      delivered += 1;
    } catch (error) {
      const failure = classifyDeliveryError(error);
      const result = record(await rpc("fail_push_delivery", {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
        p_error_code: failure.code,
        p_retryable: failure.retryable,
        p_subscription_invalid: failure.subscriptionInvalid,
      }));
      if (result.outcome === "retry_scheduled") retried += 1;
      else failedPermanent += 1;
    }
  }
  return {
    broadcastOutcome: typeof broadcast.outcome === "string" ? broadcast.outcome : "unknown",
    broadcastProcessed: typeof broadcast.processed === "number" ? broadcast.processed : 0,
    claimed: jobs.length,
    delivered,
    retried,
    failedPermanent,
  };
}
