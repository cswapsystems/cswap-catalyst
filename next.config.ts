import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lucid's browser packages ship WebAssembly modules. Amplify's supported
  // Next.js 15 builder uses webpack, where WASM must be enabled explicitly.
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    config.output.environment = { ...config.output.environment, asyncFunction: true };
    return config;
  },
};

export default nextConfig;
