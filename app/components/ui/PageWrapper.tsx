import { ReactNode } from "react";
import BackButton from "@/app/components/ui/BackButton";

export default function PageWrapper({
  children,
  showBackButton = true,
}: {
  children: ReactNode;
  showBackButton?: boolean;
}) {
  return (
    <div className="min-h-screen bg-orange-background relative">
      {showBackButton && <BackButton />}
      {children}
    </div>
  );
}