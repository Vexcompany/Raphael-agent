import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Allow the platform preview host to load dev resources. */
  allowedDevOrigins: ["*.monkeycode-ai.live"],
};

export default nextConfig;
