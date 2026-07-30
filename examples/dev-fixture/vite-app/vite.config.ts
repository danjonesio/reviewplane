import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The Vite half of the development fixture.
 *
 * It stands in for a real development server, so its configuration is the
 * configuration a user would have to arrive at themselves. Two settings below
 * are the ones that decide whether a route works at all.
 */
export default defineConfig({
  plugins: [react()],
  // The containerised fixture runs with a read-only root filesystem
  // (`deploy/compose/compose.yaml`'s `read_only: true` on the `dev-fixture`
  // service, the isolation `docs/SECURITY.md` §10 requires), so Vite's
  // dependency-optimisation cache — which it otherwise writes under
  // `node_modules/.vite` — MUST be redirected to a location that is actually
  // writable there. `VITE_CACHE_DIR` names that location; Compose sets it to
  // a path under the container's `/tmp` tmpfs. Local development sets nothing
  // and keeps Vite's own default, so `pnpm dev`/`npm run dev` outside a
  // container is unaffected.
  cacheDir: process.env.VITE_CACHE_DIR ?? "node_modules/.vite",
  server: {
    // Loopback only. The connector dials this address outbound from the same
    // machine; the development machine opens no inbound port, which is the
    // property `docs/SECURITY.md` and the RVP-11 proof both rest on. Binding
    // `0.0.0.0` — or passing `--host`, which is the same thing — would publish
    // the application to the network and make the tunnel pointless.
    host: "127.0.0.1",
    port: 5173,
    // Fail rather than silently move to 5174: the published route names a
    // port, and a fixture that wandered would produce a confusing
    // CONNECTOR_OFFLINE instead of an obvious startup error.
    strictPort: true,
    // HMR is deliberately left at its default (`hmr: true`, no explicit
    // `host`/`clientPort`/`protocol`) — that default is what RVP-14 proves.
    // With no host or port named, Vite's client (`vite/dist/client/client.mjs`)
    // derives the update-socket URL from the document it was loaded from
    // (`import.meta.url`) rather than from anything baked in at build time:
    // `wss:` when the page loaded over `https:`, and the same hostname and
    // port the page itself used. Loaded through a connector route the page's
    // origin is the gateway's internal one, `https://<alias>.internal.invalid/`
    // on the default HTTPS port, so the client MUST reach for
    // `wss://<alias>.internal.invalid/` — the gateway origin, not the
    // development machine — and the gateway is what MUST turn that upgrade
    // into a connection to this dev server. An explicit `clientPort` or
    // `protocol` is unneeded here only because the internal origin never
    // carries a non-default port (`docs/CONNECTOR_PROTOCOL.md` §13); a
    // deployment that changed that would need one, so do not hard-code a
    // hostname here to compensate — the derivation above already avoids one.
    //
    // Vite refuses a request whose `Host` it does not recognise, which is DNS
    // rebinding protection, not an obstacle to work around. It interacts
    // directly with the gateway's `host_header_mode`
    // (`docs/CONFIGURATION.md` §4):
    //
    //   - `upstream` (the default): the development server sees
    //     `Host: 127.0.0.1:5173`. Vite always allows a literal IP address, so
    //     this list is not consulted and no entry is required.
    //   - `original`: the development server sees the internal origin,
    //     `<alias>.internal.invalid`. That is not an IP literal, so it must be
    //     allowed explicitly. A leading dot matches any sub-domain, so the one
    //     entry below covers every route alias the gateway can issue.
    //
    // `allowedHosts: true` would also "work" and MUST NOT be used: it disables
    // the host check for every origin, including an attacker-controlled name
    // resolving to loopback.
    allowedHosts: [".internal.invalid"],
    // Polling, not inotify. RVP-14's proof edits a source file with `sed`
    // from `docker compose exec`, i.e. through a bind mount or a `docker cp`
    // layer, and inotify events across that boundary are unreliable — a
    // change can go unnoticed, which would turn a real product bug into a
    // flaky fixture. Polling every 200ms costs nothing a human notices and
    // makes the proof deterministic instead.
    watch: {
      usePolling: true,
      interval: 200,
    },
  },
  build: {
    // Two entry points, so the second page is a real document reached by a
    // relative link rather than a client-side route. No router dependency.
    rollupOptions: {
      input: {
        index: "index.html",
        products: "products.html",
      },
    },
  },
});
