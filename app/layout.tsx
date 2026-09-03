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
    icon: [
      {
        url: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-browser-v3-16.png",
        sizes: "16x16",
        type: "image/png",
      },
      {
        url: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-browser-v3-32.png",
        sizes: "32x32",
        type: "image/png",
      },
      {
        url: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-browser-v3-48.png",
        sizes: "48x48",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-pwa-maskable-v4-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
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
