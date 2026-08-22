export type PushDeliveryFailure = Readonly<{
  code: string;
  retryable: boolean;
  subscriptionInvalid: boolean;
}>;

export function classifyPushDeliveryError(error: unknown): PushDeliveryFailure {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error
    && typeof error.statusCode === "number" ? error.statusCode : null;
  if (statusCode === 404 || statusCode === 410) {
    return { code: `provider_${statusCode}`, retryable: false, subscriptionInvalid: true };
  }
  if (statusCode === 408 || statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
    return {
      code: statusCode ? `provider_${statusCode}` : "provider_retryable",
      retryable: true,
      subscriptionInvalid: false,
    };
  }
  return {
    code: statusCode ? `provider_${statusCode}` : "delivery_failed",
    retryable: false,
    subscriptionInvalid: false,
  };
}
