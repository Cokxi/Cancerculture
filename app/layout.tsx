import type { Metadata } from "next";
import { Bangers, Permanent_Marker } from "next/font/google";
import "./globals.css";
import { OverlayProvider } from "@/app/components/overlay/OverlayProvider";
import BackToTopButton from "@/app/components/ui/BackToTopButton";

const bangers = Bangers({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bangers",
});

const permanentMarker = Permanent_Marker({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-marker",
});

export const metadata: Metadata = {
  title: "CancerCulture",
  description: "CancerCulture",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${bangers.variable} ${permanentMarker.variable}`}
    >
      <body className="antialiased bg-orange-background overflow-x-hidden">
        <OverlayProvider>
          {children}
          <BackToTopButton />
        </OverlayProvider>
      </body>
    </html>
  );
}
