import {
  authorizeInternalTrigger,
  type InternalTriggerAuthResult,
} from "@/lib/auth/internalTriggerAuth";

export type CycleAutomationTriggerAuthResult = InternalTriggerAuthResult;

export function authorizeCycleAutomationTrigger({
  authorizationHeader,
  configuredSecret,
}: {
  authorizationHeader: string | null;
  configuredSecret: string | undefined;
}): CycleAutomationTriggerAuthResult {
  return authorizeInternalTrigger({
    authorizationHeader,
    configuredSecret,
  });
}
