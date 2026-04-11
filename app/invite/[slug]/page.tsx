import { redirect } from "next/navigation";

interface InvitePageProps {
  params: Promise<{
    slug: string;
  }>;
}

export default async function InviteConsumePage({
  params,
}: InvitePageProps) {
  const { slug } = await params;

  
  redirect(`/api/invite/consume/${slug}`);
}
