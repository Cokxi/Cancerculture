export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  parseSubmissionReportCreateInput,
} from "@/lib/reports/submissionReportContract";
import {
  assertSubmissionReportCreationOpen,
  createSubmissionReport,
  submissionReportErrorResponse,
} from "@/lib/reports/submissionReportRpc.server";
import { TURNSTILE_ACTIONS } from "@/lib/turnstile/shared";
import { verifyTurnstileRequest } from "@/lib/turnstile/verify.server";

const MAX_BODY_BYTES = 4_096;

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "INVALID_REPORT" },
        { status: 400 }
      );
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: "INVALID_REPORT" },
        { status: 400 }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      parsed = null;
    }
    const input = parseSubmissionReportCreateInput(parsed);
    if (!input) {
      return NextResponse.json(
        { error: "INVALID_REPORT" },
        { status: 400 }
      );
    }

    await assertSubmissionReportCreationOpen({
      discordUserId: session.discord_user_id,
      submissionId: input.submissionId,
    });

    const turnstile = await verifyTurnstileRequest(
      request,
      TURNSTILE_ACTIONS.submissionReport
    );

    if (turnstile.status === "rejected") {
      return NextResponse.json(
        { error: turnstile.code },
        { status: 400 }
      );
    }
    if (turnstile.status === "configuration_error") {
      return NextResponse.json(
        { error: turnstile.code },
        { status: 503 }
      );
    }
    if (turnstile.status === "provider_unavailable") {
      return NextResponse.json(
        { error: "TURNSTILE_PROVIDER_UNAVAILABLE" },
        { status: 503 }
      );
    }

    const result = await createSubmissionReport({
      discordUserId: session.discord_user_id,
      input,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const response = submissionReportErrorResponse(error);
    return NextResponse.json(
      { error: response.code },
      { status: response.status }
    );
  }
}
