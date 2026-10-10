import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every screen shows live, per-user operational data, so the opt-in
  // Cache Components / prerendering model is left off.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
