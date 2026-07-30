# Development-environment fixture

This directory is the **connector fixture** of `docs/DEVELOPMENT.md` §4: a local
development environment with applications bound to loopback, which a connector
publishes and a central Chromium session opens through a session-scoped route.

It stands in for "an agent's local application on the development VM" in the
loop `CLAUDE.md` locks:

```text
Agent starts local app -> connector publishes it privately -> central browser
worker opens it -> agent operates via MCP -> human watches/annotates -> ...
```

Two applications live here:

| Application | Address | Purpose |
|---|---|---|
| `static-app/` | `127.0.0.1:4321` | Dependency-free multi-page site. Every route exists to make one property of the route observable, including the ones that MUST fail. |
| `vite-app/` | `127.0.0.1:5173` | A real development server. Proves the fixture result is not an artefact of a hand-written server that happens to behave well. |

Both ports are in the Stage 0 destination allow-list (`docs/CONFIGURATION.md`
§4, `docs/CONNECTOR_PROTOCOL.md` §20), so a route to either is publishable
without widening any policy.

## Why loopback only

The connector connects **outbound** and dials the development service over
loopback from the same machine. Nothing inbound is opened, which is Stage 0 exit
criterion 5 and an acceptance criterion of RVP-11: *no inbound port is opened on
the development VM during the whole flow*.

A fixture that quietly bound `0.0.0.0` would still pass every tunnel test while
destroying the property the tunnel exists to preserve, so both applications
refuse to do it:

- `static-app` validates its bind address at startup and exits with an
  explanatory error unless the address is a literal loopback address
  (`127.0.0.0/8` or `::1`). A name such as `localhost` is refused rather than
  resolved, matching the destination policy in `apps/server`: the address a
  resolver returns need not be the one the check approved.
- `vite-app` sets `server.host` to `127.0.0.1` with `strictPort: true`. Do not
  run it with `--host`, which is Vite's way of spelling `0.0.0.0`.

## Why this is outside the pnpm workspace

`pnpm-workspace.yaml` lists `apps/*` and `packages/*`. `examples/*` is therefore
already outside the workspace, and it MUST stay that way. The fixture stands in
for a user's application: if it shared the monorepo's dependency graph it could
not falsify a claim about the product, because a hoisted dependency or a
`workspace:*` link would be doing work no real user's application would have.
Neither application depends on `@reviewplane/protocol` or on anything else in
the repository.

Two consequences worth knowing:

- `pnpm install` at the root does not install these dependencies. Install them
  in the fixture directory when you want to run the Vite application.
- `pnpm lint` at the root runs `eslint .` over the whole tree, so these files
  **are** linted. `pnpm typecheck` and `pnpm test` use `pnpm -r`, which visits
  workspace members only, so neither reaches the fixture: run its tests with the
  command below, and wire that command into continuous integration alongside the
  end-to-end scenario rather than assuming the root scripts cover it. Each
  application carries its own `tsconfig.json` for an editor and for a deliberate
  `tsc --noEmit`.

## Running the static application

No install step and no build step. Node runs the TypeScript sources directly.

```bash
cd examples/dev-fixture/static-app
node src/main.ts                 # 127.0.0.1:4321
PORT=4400 node src/main.ts       # a different loopback port
HOST=0.0.0.0 node src/main.ts    # refused, with an explanation
```

One structured line per request goes to stdout:

```json
{"level":"info","service":"static-app","method":"GET","path":"/","status":200,"host_header":"127.0.0.1:4321","x_forwarded_host":null,"x_forwarded_proto":null}
```

`host_header` is recorded exactly as received and is never normalised: which
value appears there is the evidence for the gateway's `host_header_mode`, and a
tidied copy would be worthless. Capture this log alongside the browser evidence
when writing up header behaviour for `docs/CONNECTOR_PROTOCOL.md` §13.

Tests:

```bash
cd examples/dev-fixture/static-app
node --test "test/**/*.test.ts"
```

## Running the Vite application

```bash
cd examples/dev-fixture/vite-app
pnpm install
pnpm dev                         # 127.0.0.1:5173
```

Hot module replacement is disabled (`server.hmr: false`). HMR needs a WebSocket
upgrade, which the gateway currently refuses with `UNSUPPORTED_CAPABILITY`, and
it belongs to the tunnel-compatibility issue rather than to this one. Disabling
it keeps a green run here evidence about plain HTTP/1.1 page and sub-resource
loading and about nothing else, instead of console noise on every page.

## Proving no inbound port is open

Run this on the development machine **while the browser session is loading the
page**, not before or after — the claim is about the whole flow:

```bash
ss -ltnp
```

To look at the fixture ports alone:

```bash
ss -ltnp 'sport = :4321 or sport = :5173'
```

A passing result binds loopback and nothing else:

```text
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511        127.0.0.1:4321      0.0.0.0:*     users:(("MainThread",pid=443989,fd=21))
```

The load-bearing column is **Local Address:Port**. `127.0.0.1:4321` or
`[::1]:5173` is the result the proof requires. `0.0.0.0:4321`, `*:4321` or
`[::]:4321` means the application is listening on every interface and the
evidence is void. (`Peer Address:Port` reads `0.0.0.0:*` on a loopback listener
too — that column is the accepted peer wildcard, not the bind address. The
process name is whatever the runtime reports; Node shows a thread name.)

To assert the stronger claim — that publishing the service added no inbound
listener anywhere on the machine — list every listener that is **not** on
loopback:

```bash
ss -ltnH | grep -Ev '127\.0\.0\.[0-9]+(%[a-z0-9]+)?:|\[::1\]:'
```

No development-server port may appear: not 4321, not 5173, and nothing else the
agent's application opened. Pre-existing administration services are outside the
claim and commonly do appear — `sshd` on `0.0.0.0:22` is how the VM is reached
in the first place — so read the output rather than expecting it to be empty.

Attach the output to the pull request. RVP-11 requires `ss -ltnp` taken during
the successful load as evidence, not a description of it.

## Routes and what each one proves

All served by `static-app`. Every response carries `cache-control: no-store`, so
a screenshot taken after a change shows the change rather than a cached page.

| Route | Status | What it proves |
|---|---|---|
| `GET /` | 200 HTML | The home page names one stylesheet, one script and one image by **root-relative** URL (`/assets/site.css`, `/assets/site.js`, `/assets/logo.svg`). All three MUST return 200 through the route: that is the sub-resource half of acceptance criterion 3. |
| `GET /products` | 200 HTML | Target of the home page's **relative** link `<a href="products">`. Reaching it proves relative URLs resolve against the published-service origin (`docs/MCP_SPEC.md` §7.4) rather than against the development machine. |
| `GET /checkout` | 200 HTML | Target of a **root-relative** link. A third page, so a review can be recorded against a specific page of a multi-page application. |
| `GET /assets/site.css` | 200 CSS | The stylesheet. `.css-probe` is green only when it loaded, so a screenshot shows whether it arrived. |
| `GET /assets/site.js` | 200 JS | The script. It sets `data-fixture-js="ready"` on `<html>` and rewrites the element with `data-testid="script-status"` to `script ran`, which proves the browser executed it rather than merely fetching it. |
| `GET /assets/logo.svg` | 200 SVG | The image sub-resource. |
| `GET /absolute-url` | 200 HTML | The documented dev-server failure mode. See below. |
| `GET /cross-origin` | 200 HTML | Its only sub-resource is `<img src="http://127.0.0.1:9/blocked.png">`, plus a link to another host. A route is a capability for one destination, never a general proxy, and the destination is never taken from the browser request (`docs/CONNECTOR_PROTOCOL.md` §12). The image request MUST fail — acceptance criterion 6. |
| `GET /slow?ms=N` | 200 HTML | Holds the response for `N` ms before the first byte, bounded at 120000. For the fault-injection case "dev server returning a slow response → bounded timeout with a stable error". The bound exists so that fault injection cannot turn into a hung suite. |
| `GET /truncated` | 200 text | Announces a `Content-Length` four times the bytes it writes, then destroys the socket. For the truncated-response case. A client that trusts `Content-Length` sees a short read: `curl` reports `end of response with 162 bytes missing`. |
| `GET /healthz` | 200 JSON | `{"status":"ok"}`. Readiness for the bounded startup grace of `docs/CONNECTOR_PROTOCOL.md` §11 — publish before this answers and the connector MUST end the grace with `PORT_NOT_LISTENING`, never an indefinite wait. |
| anything else | 404 HTML | A small page, so a wrong path is visibly a 404 rather than a blank screen. |

Key elements carry a `data-testid`, and each page's heading carries
`id="page-title"`, so a browser test asserts on a stable hook rather than on
prose. Both applications include `<meta name="viewport">` and responsive CSS,
and are legible at 1440x900 and 390x844 (`AGENTS.md` "Browser-facing work").

## The known absolute-URL failure mode

`GET /absolute-url` emits a stylesheet reference built from the server's own
bound address:

```html
<link rel="stylesheet" href="http://127.0.0.1:4321/assets/site.css">
```

This is what a development server that derives absolute URLs from its listen
address produces, and through a connector route it **MUST fail**. Chromium sees
the internal origin `https://<public_alias>.internal.invalid/`; `127.0.0.1` inside the
browser container is that container, not the development machine, and the
gateway routes by the origin it issued rather than by whatever host a page asks
for.

RVP-11's design notes are explicit that this is *"an expected failure mode and
MUST be characterised in the evidence, not silently patched by rewriting
response bodies"*. Rewriting page content in the gateway would make the gateway
parse and edit untrusted HTML, which contradicts `docs/SECURITY.md` on treating
page content as untrusted, and would still miss URLs built in JavaScript. So the
fixture makes the failure reproducible and the write-up records it. The page
carries an HTML comment saying the same thing, for whoever meets it first
through a broken render.

Report the observed behaviour — which request failed, with what browser-side
error — in the pull request's header-behaviour note.

## Host, Origin and forwarded headers

Header handling is fixed in configuration, never per request
(`docs/CONNECTOR_PROTOCOL.md` §13, `services/tunnel-gateway/README.md`). What
the fixture sees depends on `host_header_mode`, and it logs all of it:

| Gateway setting | `Host` the fixture receives | What the fixture must do |
|---|---|---|
| `host_header_mode: upstream` (default) | `127.0.0.1:4321`, `127.0.0.1:5173` | Nothing. Vite always allows a literal IP address, which is why this mode satisfies a development server's DNS-rebinding protection out of the box. |
| `host_header_mode: original` | `<alias>.internal.invalid` | Vite MUST be told to allow it. `vite.config.ts` sets `allowedHosts: [".internal.invalid"]`; the leading dot matches every alias the gateway can issue. |

`allowedHosts: true` would also make the page load and MUST NOT be used: it
disables the host check for every origin, including an attacker-controlled name
resolving to loopback.

With `forwarded_header_mode: standard` the fixture additionally receives
`X-Forwarded-Proto: https` and `X-Forwarded-Host: <alias>.internal.invalid`, and
no `X-Forwarded-For`. Both appear in the static application's request log and in
the `RequestRecord` entries its test API exposes.

## Test API

`static-app` is startable in-process, so a test drives the same code path
without a subprocess:

```ts
import { startStaticApp } from "./src/app.ts";

const app = await startStaticApp({ port: 0, logLine: (line) => lines.push(line) });
// app.origin, app.port, app.requests: RequestRecord[]
await app.stop();
```

`RequestRecord` captures the method, the path and the `host`, `origin`,
`x-forwarded-host` and `x-forwarded-proto` headers as received.
