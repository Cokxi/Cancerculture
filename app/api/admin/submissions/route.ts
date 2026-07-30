import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/admin";
import { requireSubmissionModerator } from "@/lib/auth/guards";
import { getPublicImageUrl } from "@/lib/r2/getPublicImageUrl";

export async function GET(req: Request) {
  try {
    
    await requireSubmissionModerator();

    const { searchParams } = new URL(req.url);
    const cycleId = searchParams.get("cycle_id");
    const limit = Number(searchParams.get("limit") ?? 50);

    let query = supabaseAdmin
      .from("submissions")
      .select(
        `
        id,
        cycle_id,
        r2_key,
        is_disqualified,
        disqualification_type,
        disqualification_reason_code,
        disqualification_reason_text,
        created_at,
        voting_cycles!inner(status, paused_from_status)
        `
      )
      .in("voting_cycles.status", [
        "active",
        "submission_open",
        "paused",
      ])
      .order("created_at", { ascending: false })
      .limit(limit);

    if (cycleId) {
      query = query.eq("cycle_id", cycleId);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: "Failed to load submissions" },
        { status: 500 }
      );
    }

    const submissionsWithUrls = (data ?? [])
      .filter((submission) => {
        const cycle = Array.isArray(submission.voting_cycles)
          ? submission.voting_cycles[0]
          : submission.voting_cycles;

        return (
          cycle?.status !== "paused" ||
          cycle.paused_from_status === "submission_open"
        );
      })
      .map((submission) => ({
        ...submission,
        image_url: getPublicImageUrl(submission.r2_key) ?? "",
      }));

    return NextResponse.json({
      submissions: submissionsWithUrls,
    });
  } catch (error: unknown) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : null;
    const message =
      error instanceof Error ? error.message : "Unauthorized";
    
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: message },
        { status }
      );
    }

    console.error("ADMIN SUBMISSIONS ERROR", error);

    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 403 }
    );
  }
}
