# Docker Compose Deployment

This directory contains the supported single-host deployment.

Present today:

```text
compose.yaml                    PostgreSQL, server and browser worker
browser-worker-seccomp.json     seccomp profile for the browser worker
.env.example                    non-secret settings
secrets/                        mounted secret files, never committed
```

Still planned:

```text
compose.override.example.yaml
Caddyfile
configure
reviewplane
backup
restore
upgrade
```

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

```bash
pnpm test:e2e                            # about three minutes, needs Docker
REVIEWPLANE_E2E_KEEP_UP=1 pnpm test:e2e  # leave the stack running to inspect
```

Evidence lands in `e2e/evidence/`: screenshots at both required viewports, the
network summary the development service recorded, `ss -ltnp` taken inside the
development environment during the load, the event sequence, the observed
header behaviour and the absolute-URL finding. None of it is committed.

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
"explicit network routes only", and these four are the whole set:

| Network | Members | Why |
|---|---|---|
| `data` | postgres, server | The database is reachable by the control plane and nothing else. |
| `browser` | server, browser-worker | The control plane commands the worker. |
| `tunnel` | server, tunnel-gateway, browser-worker | The worker reaches published services only through the gateway; the control plane reaches the gateway's admin API. |
| `devnet` | server, tunnel-gateway, dev-fixture | The development environment dials out to enrol and to open its data channel. Nothing dials in. |

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
