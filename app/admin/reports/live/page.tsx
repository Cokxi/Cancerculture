export const dynamic = "force-dynamic";

import SubmissionReportAreaPage from "../SubmissionReportAreaPage";

export default async function LiveSubmissionReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ case?: string }>;
}) {
  const { case: initialCaseId } = await searchParams;
  return <SubmissionReportAreaPage area="live" initialCaseId={initialCaseId} />;
}
