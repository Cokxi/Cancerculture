export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAuthErrorStatus } from "@/lib/auth/AuthError";
import { requireSession } from "@/lib/auth/requireSession";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";
import {
  WALLET_ISSUE_REQUEST_ID_HEADER,
  WALLET_ISSUE_SCREENSHOT_MAX_BYTES,
  WALLET_ISSUE_SUBMISSION_ID_HEADER,
  isUuid,
  parseSubmissionId,
} from "@/lib/walletIssues/contract";
import {
  assertWalletIssueIntakeOpen,
  createWalletIssueIntake,
  getWalletIssueIntakeReplay,
} from "@/lib/walletIssues/service.server";
import {
  normalizeWalletIssueScreenshot,
  WalletIssueScreenshotError,
} from "@/lib/walletIssues/screenshot.server";

const MAX_MULTIPART_BYTES = WALLET_ISSUE_SCREENSHOT_MAX_BYTES + 32_768;

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const requestId = request.headers.get(WALLET_ISSUE_REQUEST_ID_HEADER)?.trim() ?? "";
    const submissionId = parseSubmissionId(
      request.headers.get(WALLET_ISSUE_SUBMISSION_ID_HEADER)
    );
    if (!isUuid(requestId) || submissionId === null) {
      return NextResponse.json({ error: "WALLET_ISSUE_INTAKE_INPUT_INVALID" }, { status: 400 });
    }

    const replay = await getWalletIssueIntakeReplay(session, requestId);
    if (replay) return NextResponse.json(replay, { headers: { "Cache-Control": "no-store" } });

    const eligibility = await assertWalletIssueIntakeOpen(session, submissionId);
    if (eligibility.outcome === "existing") {
      return NextResponse.json(eligibility, { headers: { "Cache-Control": "no-store" } });
    }

    const verification = await verifyTurnstileRequest(
      request,
      TURNSTILE_ACTIONS.walletIssueIntake
    );
    if (verification.status !== "verified") {
      const unavailable = verification.status === "provider_unavailable" ||
        verification.status === "configuration_error";
      return NextResponse.json(
        { error: unavailable ? "TURNSTILE_PROVIDER_UNAVAILABLE" : verification.code },
        { status: unavailable ? 503 : 400 }
      );
    }

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
      return NextResponse.json({ error: "WALLET_ISSUE_SCREENSHOT_INVALID" }, { status: 400 });
    }
    const form = await request.formData();
    const desiredRecipient = form.get("desiredRecipient");
    const description = form.get("description");
    const screenshotValue = form.get("screenshot");
    if (typeof desiredRecipient !== "string" || typeof description !== "string") {
      return NextResponse.json({ error: "WALLET_ISSUE_INTAKE_INPUT_INVALID" }, { status: 400 });
    }
    const screenshot = await normalizeWalletIssueScreenshot(
      screenshotValue instanceof File ? screenshotValue : null
    );
    const result = await createWalletIssueIntake({
      session,
      submissionId,
      requestId,
      desiredRecipient,
      description,
      screenshot,
    });
    return NextResponse.json(result, {
      status: result.outcome === "created" ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof WalletIssueScreenshotError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const status = getAuthErrorStatus(error) ?? 503;
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{4,}$/u.test(error.message)
      ? error.message
      : "WALLET_ISSUE_UNAVAILABLE";
    return NextResponse.json({ error: code }, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
