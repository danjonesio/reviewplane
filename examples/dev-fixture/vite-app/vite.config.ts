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
    // HMR is out of scope for this issue and belongs to the WebSocket and
    // hot-reload work (RVP-14). Disabled here so that a green run of this
    // fixture is evidence about plain HTTP/1.1 page and sub-resource loading
    // and about nothing else: with HMR on, a failed WebSocket upgrade — which
    // the gateway currently refuses with UNSUPPORTED_CAPABILITY — would show
    // up as console noise on every page and muddy the result.
    hmr: false,
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
