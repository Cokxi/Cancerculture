import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "CancerCulture",
    short_name: "CCulture",
    description: "CancerCulture community memes, voting, and cycle results.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0b0b",
    theme_color: "#ff5a1f",
    categories: ["entertainment", "social"],
    icons: [
      {
        src: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-browser-v3-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-browser-v3-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "https://cdn.cancerculture.fun/png/cc-icons-frameless-v4/cc-pwa-maskable-v4-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
