/**
 * Vite configuration for the web application (ADR-0011).
 *
 * Two settings are requirements rather than preferences:
 *
 *   * `resolve.conditions` names `development`, so a fresh clone resolves
 *     `@reviewplane/protocol` from its TypeScript sources exactly as
 *     `pnpm typecheck` and `pnpm test` do. Without it a build would need a
 *     prior `pnpm build` of the protocol package, which `docs/DEVELOPMENT.md`
 *     section 5 says a root command must not require.
 *   * nothing is loaded from a network at run time. ADR-0011's unchanged
 *     requirements forbid a CDN, a hosted font and analytics, so every asset
 *     is emitted into the bundle and `build.assetsInlineLimit` is left at its
 *     default rather than pushing anything out to a remote host.
 */

import { fileURLToPath } from "node:url";

import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwind()],
  resolve: {
    conditions: ["development", "module", "browser"],
  },
  optimizeDeps: {
    // The protocol package ships TypeScript sources under the development
    // condition; pre-bundling it would resolve the published entry instead.
    exclude: ["@reviewplane/protocol"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Route-level code splitting is the only bundle-management mechanism
    // ADR-0011 asks for; the defaults already produce it.
    target: "es2023",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/ws": { target: "ws://127.0.0.1:8080", ws: true, changeOrigin: false },
    },
  },
});
