import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "uploads.cancerculture.fun",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "66aeb3c40b2cd0a34ae65dc74c009dcc.r2.cloudflarestorage.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "pub-b3364ce2f8ac4014af02207b9bfbd45d.r2.dev",
        pathname: "/**",
      },
      {
  protocol: "https",
  hostname: "cdn.cancerculture.fun",
  pathname: "/**",
},
    ],
  },
};

export default nextConfig;
