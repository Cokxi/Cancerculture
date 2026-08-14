"use client";

import { useRouter } from "next/navigation";
import ModalCloseButton from "@/app/components/ui/ModalCloseButton";

export default function CommunityFeedDetailCloseButton() {
  const router = useRouter();

  return (
    <ModalCloseButton
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
          return;
        }

        router.push("/spread");
      }}
    />
  );
}
