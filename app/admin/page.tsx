
import { redirect } from "next/navigation";
import BackButton from "@/app/components/ui/BackButton";
export default function AdminIndexPage() {
  redirect("/admin/logs");
}

<BackButton />