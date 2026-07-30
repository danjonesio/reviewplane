# Docker Compose Deployment

This directory contains the supported single-host deployment.

Present today:

```text
compose.yaml                    gateway, PostgreSQL, server, MCP server, browser
                                worker, tunnel gateway, development fixture
gateway/Dockerfile              builds the web application and the Caddy image
gateway/Caddyfile               TLS, routing, WebSocket upgrades, static assets
browser-worker-seccomp.json     seccomp profile for the browser worker
connector-config.yaml           the development fixture's connector settings
tls/                            the tunnel certificate authority and its leaf
e2e/                            the end-to-end scenario and its generators
.env.example                    non-secret settings
secrets/                        mounted secret files, never committed
```

Still planned:

```text
compose.override.example.yaml
configure
reviewplane
backup
restore
upgrade
```

## Gateway

`gateway` is the only service that publishes a host port
(`docs/ARCHITECTURE.md` §4.1). It serves `apps/web`'s build output, proxies
`/api` and upgrades `/ws` to the control plane, routes `/mcp` to the MCP server,
and refuses `/internal` outright so that a misconfigured network cannot expose
the browser-worker channel. It holds no credential, reaches neither PostgreSQL
nor the worker, and mounts no Docker socket.

## MCP server

`mcp-server` is the agent-facing process (`docs/ARCHITECTURE.md` §4.4,
ADR-0020). It is a separate process behind a separate route, so a gateway rule
written for the human API cannot expose the agent one as a side effect, and the
two have different credentials, different bodies and different limits.

It is the same trust zone as `server` — same database, same worker command
credential — and deliberately narrower in two ways: it is not given the
bootstrap token, so the agent-facing process cannot present an administrator
credential, and its artefact volume is mounted read-only, because evidence is
written by the worker through the control-plane API and only read here.

The web application is built inside the gateway image because ADR-0011 removed
the server-rendering process: the build output is static files, and this is the
component that serves static files. That build fails if the bundle would fetch
from another host, so an image cannot be produced from one that would.

Stage 0 terminates TLS with Caddy's internal certificate authority, so a fresh
install is HTTPS from first boot and the viewer session cookie can be `Secure`.
An operator terminating TLS elsewhere replaces the `tls` directive and points
`REVIEWPLANE_PUBLIC_ORIGIN` at their own address; that value is also the origin
the control plane accepts a live-view WebSocket upgrade from.

## Browser-worker isolation

The worker is the only component that executes untrusted page content, so its
service block carries the `docs/SECURITY.md` §10 controls rather than leaving
them to the operator: a dedicated non-root user, a read-only root filesystem
with tmpfs mounts for the per-session profile directories, every capability
dropped except `SYS_CHROOT`, `no-new-privileges`, a seccomp profile, an
internal-only network and no published host port. No container mounts the
Docker socket.

`browser-worker-seccomp.json` is Docker's default seccomp profile with exactly
one change: `clone`, `clone3` and `unshare` no longer require `CAP_SYS_ADMIN`.
Chromium's own sandbox is built on user namespaces, so the default profile
makes it fail with "No usable sandbox" and pushes an operator towards the
unsupported `--no-sandbox` workaround. Every other gate in the profile,
including `CAP_SYS_ADMIN` on `mount`, `pivot_root` and `setns`, is untouched.
`SYS_CHROOT` is added back for the same reason as the three syscalls:
Chromium's sandboxed zygote chroots itself into an empty directory inside its
new namespace.

Those three are the measured minimum, not a guess. Each was removed in turn and
the browser suite re-run under the result:

| Ungated | Outcome |
|---|---|
| `clone` only | Node cannot start; the process aborts creating a thread |
| `clone`, `clone3` | 22 of 23 tests fail with "No usable sandbox" — `unshare` is what creates the namespace |
| `clone`, `unshare` | Node cannot start; modern glibc uses `clone3` for threads |
| `clone`, `clone3`, `unshare` | 23 of 23 pass |
| the three plus `setns` | 23 of 23 pass — `setns` joins an existing namespace and is not needed |

`setns` therefore stays behind the `CAP_SYS_ADMIN` gate it has in Docker's
default profile, and the container drops that capability.

On a host that restricts unprivileged user namespaces — Ubuntu 23.10 and later
set `kernel.apparmor_restrict_unprivileged_userns=1` — the profile alone is not
enough, because the restriction is enforced by AppArmor rather than by seccomp.
Such a host needs either an AppArmor profile granting the container the
`userns` permission, or that sysctl set to `0`. Disabling the Chromium sandbox
is not the supported alternative.

`apps/browser-worker/scripts/run-browser-tests.sh` runs the browser test suite
under exactly these controls, so the suite proves the deployed posture rather
than a laxer local one.

Requirements and security constraints are defined in:

- `../../docs/DEPLOYMENT.md`
- `../../docs/CONFIGURATION.md`
- `../../docs/SECURITY.md`
- `../../docs/OPERATIONS.md`

The initial implementation must preserve these rules:

- Only the gateway publishes host ports by default.
- Chromium runs in `browser-worker`, not the API container.
- The API container does not mount the Docker socket.
- PostgreSQL is a private service; artefacts live on a private local volume by default (ADR-0012).
- Secrets are mounted as files where possible.
- Images are pinned to release versions or digests.

## End-to-end scenario

`pnpm test:e2e` runs `e2e/run.sh`, which is steps 1 to 6 of the primary
scenario in `docs/TESTING.md` §3: start the stack, enrol the connector fixture,
start the fixture application on connector loopback, publish it, allocate a
browser session against the route, and navigate. It is release-blocking for the
Stage 0 exit criterion "a dev server bound to loopback on a remote VM is usable
by central Chromium".

It then proves the tunnel capabilities `docs/ARCHITECTURE.md` §7.4 makes
mandatory, which those six steps do not reach: a WebSocket echo and server-sent
events through the route, Vite hot module replacement applying a source edit
made on the development machine to the page in central Chromium without a full
reload, and the performance baseline of `docs/TESTING.md` §12.

```bash
pnpm test:e2e                            # about five minutes, needs Docker
REVIEWPLANE_E2E_KEEP_UP=1 pnpm test:e2e  # leave the stack running to inspect
```

Each run uses its own Compose project name — `reviewplane-e2e-<pid>-<epoch>` —
so two runs on one machine do not share containers, networks or volumes and
cannot tear each other down mid-flight. Set `COMPOSE_PROJECT_NAME` to fix it
when a predictable name is wanted for debugging; teardown always names the
project it created, and the name is printed at the start of a run and again if
the stack is left up.

Evidence lands in `e2e/evidence/`: screenshots at both required viewports, the
before-and-after pair for the hot-reload proof, the network summary the
development service recorded, `ss -ltnp` taken inside the development
environment during the load, the event sequence, the observed header behaviour,
the absolute-URL finding, the WebSocket and server-sent-event results with
their arrival gaps, the gateway's metrics and the performance baseline. None of
it is committed.

The `dev-fixture` service runs both fixture applications: the static one on
`127.0.0.1:4321` and a real Vite development server on `127.0.0.1:5173`. Set
`REVIEWPLANE_FIXTURE_VITE=0` on that service to skip the Vite half. It keeps a
read-only root filesystem; exactly one path is writable, the named volume at
`/app/vite-app/src`, because the hot-reload proof has to edit a source file
while the stack is running. Vite's dependency cache is redirected onto the
container's tmpfs by `VITE_CACHE_DIR`.

`e2e/generate-secrets.sh` writes the development credentials and the tunnel CA.
It is idempotent, because regenerating the capability signing key would
invalidate every capability already minted and regenerating the gateway
certificate would invalidate the pin the browser worker was started with
(ADR-0015); pass `--force` to replace everything.

### Why the generated secrets are mode 0644

`uid`, `gid` and `mode` on a Compose secret reference are honoured by Docker
Swarm only. Plain Compose bind-mounts a file-backed secret with the permissions
it has on the host, and every service here runs as uid 10001 rather than as the
user who ran the script, so a 0600 secret is unreadable to the service that
needs it.

These are generated development credentials for a stack that publishes no host
port and has no route to the internet, and the directory is the boundary. A
production deployment MUST NOT copy this: deliver secrets through Swarm or
Kubernetes secrets, or pre-create the files owned by the service user.

### Network topology

Every network is `internal: true`, so Docker attaches no gateway to any of them
and no container can reach the internet. `docs/ARCHITECTURE.md` §6.2 permits
"explicit network routes only", and these five are the whole set:

| Network | Members | Why |
|---|---|---|
| `data` | postgres, server, mcp-server | The database is reachable by the two processes that own domain state and nothing else. |
| `browser` | server, mcp-server, browser-worker | The control plane and the agent endpoint command the worker. |
| `tunnel` | server, tunnel-gateway, browser-worker | The worker reaches published services only through the tunnel gateway; the control plane reaches the gateway's admin API. |
| `devnet` | server, tunnel-gateway, dev-fixture | The development environment dials out to enrol and to open its data channel. Nothing dials in. |
| `edge` | gateway, server, mcp-server | The edge gateway is the only service with a published host port, and it reaches the two HTTP processes over this network rather than over the host. |

The browser worker is on `browser` and `tunnel`. It has no route to `devnet`,
so it cannot reach the development environment except through a route the
gateway is carrying — which is what makes a published service a capability for
one destination rather than network reach.

The `dev-fixture` service stands in for a developer's VM and publishes no port
at all. There is deliberately no `ports:` and no `expose:` on it, and the
scenario asserts that no container in the project publishes a host port.

### Rotating the gateway certificate

The browser worker pins the gateway certificate's public key (ADR-0015), so a
new certificate needs a new pin:

```bash
deploy/compose/e2e/generate-secrets.sh --force   # rewrites .env with the new pin
docker compose --profile e2e up -d --force-recreate tunnel-gateway browser-worker
```
