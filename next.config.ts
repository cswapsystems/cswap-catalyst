import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep verification builds separate from a concurrently running dev server.
  distDir: process.env.CSWAP_NEXT_DIST_DIR || ".next",
  // Lucid's browser packages ship WebAssembly modules. Amplify's supported
  // Next.js 15 builder uses webpack, where WASM must be enabled explicitly.
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    config.output.environment = { ...config.output.environment, asyncFunction: true };
    return config;
  },
};

export default nextConfig;
