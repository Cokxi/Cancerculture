import type { Metadata, Viewport } from "next";
import { Bangers, Permanent_Marker } from "next/font/google";
import "./globals.css";
import GlobalAccount from "@/app/components/auth/GlobalAccount";
import { OverlayProvider } from "@/app/components/overlay/OverlayProvider";
import { SponsorAnalyticsProvider } from "@/app/components/sponsors/SponsorAnalyticsProvider";
import BackToTopButton from "@/app/components/ui/BackToTopButton";
import PwaShell from "@/app/components/pwa/PwaShell";

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
  applicationName: "CancerCulture",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icons/pwa-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#ff5a1f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${bangers.variable} ${permanentMarker.variable}`}
    >
      <body className="antialiased bg-orange-background overflow-x-hidden">
        <OverlayProvider>
          <SponsorAnalyticsProvider>
            {children}
            <GlobalAccount />
            <BackToTopButton />
            <PwaShell />
          </SponsorAnalyticsProvider>
        </OverlayProvider>
      </body>
    </html>
  );
}
