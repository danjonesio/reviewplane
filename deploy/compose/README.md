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
