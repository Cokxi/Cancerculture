import { redirect } from "next/navigation";

interface InvitePageProps {
  params: Promise<{
    slug: string;
  }>;
}

export default async function InviteConsumePage({
  params,
}: InvitePageProps) {
  await params;
  redirect("/?invite=retired");
}
