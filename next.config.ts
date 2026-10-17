import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Cache Components (PPR) is deliberately OFF.
   *
   * This is a single-owner dashboard: every screen reads the session cookie and
   * the live database, so there is no static shell worth prerendering, and
   * turning it on would require Suspense boundaries around data that is dynamic
   * by nature. Classic dynamic rendering is the honest model here.
   * Turbopack stays on (Next 16 default) with partialPrefetching.
   */
  cacheComponents: false,
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
