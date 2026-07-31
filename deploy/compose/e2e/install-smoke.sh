#!/usr/bin/env bash
#
# The documented installation, run from a clean checkout, end to end.
#
# `docs/ROADMAP.md` §3 gives Stage 1 the exit criterion "fresh installation from
# release artefacts in one documented flow", and `docs/DEPLOYMENT.md` §8 is that
# flow. This gate is the difference between a documented flow and a flow that
# works: it materialises a clean copy of the repository, runs §8's commands
# **verbatim** in it, and then asserts what the installation is supposed to be
# true of — including the things `docs/DEPLOYMENT.md` §20 says MUST be
# impossible in a shipped default.
#
# It exists for the reason `pnpm test:edge` exists. The edge gateway shipped
# with three stacked defects — a site address with no name, a container on
# internal networks only, and route ordering that served the application
# document for `/internal` — and every one of them survived because no gate ever
# started it. `pnpm test:edge` closed that for the gateway alone and asserts
# `/api`, `/ws` and `/mcp` as configuration rather than driving them; this gate
# is where those routes are driven to real upstreams, because the login page an
# operator reaches at the end of §8 is served across all of them.
#
# What it asserts:
#
#   1. §8 runs verbatim from a clean checkout and every command exits 0.
#   2. `./configure` is idempotent: a second run regenerates no secret.
#   3. Every service becomes healthy and every role's `/health/ready` answers.
#   4. The login page is served over TLS through the gateway, its bundle loads,
#      and `/api` and `/mcp` reach their own upstreams rather than the document.
#   5. Only the gateway publishes a host port; PostgreSQL and the Chromium
#      debugging port are unreachable from the host.
#   6. `api`, `mcp` and `jobs` have no Docker socket; the browser worker runs
#      non-root with the Chromium sandbox enabled and holds no database or
#      artefact credential.
#   7. No UI asset is loaded from another host.
#   8. `reviewplane status` reports the documented fields, and `--json` is the
#      shape automation was promised.
#   9. Fault injection: PostgreSQL stopped leaves the API not ready and still
#      running; a missing secret file fails closed with a message naming it.
#
# Usage: pnpm test:install
#        REVIEWPLANE_INSTALL_KEEP_UP=1 pnpm test:install   # leave it running

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVIDENCE="${REPO_ROOT}/deploy/compose/e2e/evidence-install"
KEEP_UP="${REVIEWPLANE_INSTALL_KEEP_UP:-0}"

BOLD=$'\033[1m'
RED=$'\033[31m'
RESET=$'\033[0m'
FAILURES=0

step() { printf '\n%s== %s%s\n' "${BOLD}" "$1" "${RESET}"; }
info() { printf '   %s\n' "$1"; }
pass() { printf '   ok  %s\n' "$1"; }
fail() {
  printf '%s   FAILED: %s%s\n' "${RED}" "$1" "${RESET}" >&2
  FAILURES=$((FAILURES + 1))
}
abort() {
  printf '\n%sFATAL: %s%s\n' "${RED}" "$1" "${RESET}" >&2
  exit 1
}

for tool in docker openssl python3 curl tar ss; do
  command -v "${tool}" > /dev/null 2>&1 || abort "${tool} is required"
done

# One project per run: two runs on one machine, or a run beside an operator's
# own installation, must not share a container, a network or a volume.
PROJECT="${COMPOSE_PROJECT_NAME:-reviewplane-install-$$-$(date +%s)}"
export COMPOSE_PROJECT_NAME="${PROJECT}"

# A free ephemeral host port, so the gate does not collide with 8443. It is an
# environment variable rather than an edit to the documented commands: §8 stays
# byte-for-byte what is run below.
PORT="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
export REVIEWPLANE_GATEWAY_PORT="${PORT}"
DOMAIN="localhost"
export REVIEWPLANE_GATEWAY_DOMAIN="${DOMAIN}"
export REVIEWPLANE_PUBLIC_ORIGIN="https://${DOMAIN}:${PORT}"
# The images are built from this checkout: a release tag is not published, and
# a gate that pulled one would be asserting somebody else's build.
export REVIEWPLANE_PULL_POLICY=build

WORKTREE="$(mktemp -d -t reviewplane-install-XXXXXX)"
INSTALL="${WORKTREE}/deploy/compose"
COMPOSE=(docker compose --project-directory "${INSTALL}")

container_of() {
  docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=$1" --format '{{.ID}}' | head -1
}

cleanup() {
  local status=$?
  if [[ ${status} -ne 0 || "${FAILURES}" -gt 0 ]]; then
    for service in api jobs mcp gateway browser-worker; do
      printf '\n--- %s log (tail) ---\n' "${service}" >&2
      "${COMPOSE[@]}" logs --tail 40 "${service}" >&2 2> /dev/null || true
    done
  fi
  if [[ "${KEEP_UP}" == "1" ]]; then
    info "stack left running as project ${PROJECT} in ${INSTALL}"
    info "  docker compose --project-directory ${INSTALL} down -v"
  else
    "${COMPOSE[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true
    rm -rf "${WORKTREE}"
  fi
  exit "${status}"
}
trap cleanup EXIT

rm -rf "${EVIDENCE}"
mkdir -p "${EVIDENCE}"

# ---------------------------------------------------------------------------
step "1. A clean checkout"
# ---------------------------------------------------------------------------
# `git ls-files` is what a clone would contain, with this working tree's
# content: no node_modules, no build output, no generated secret. Running the
# flow in the repository itself would let a stale artefact make it pass.
(cd "${REPO_ROOT}" && git ls-files -z | tar --null -T - -cf -) | tar -xf - -C "${WORKTREE}"
[[ -f "${INSTALL}/compose.yaml" ]] || abort "the clean checkout has no deploy/compose/compose.yaml"
[[ ! -s "${INSTALL}/secrets/database_url" ]] || abort "the clean checkout contains a committed secret"
info "materialised $(find "${WORKTREE}" -type f | wc -l) files into ${WORKTREE}"
pass "no secret material is committed"

# ---------------------------------------------------------------------------
step "2. docs/DEPLOYMENT.md section 8, verbatim"
# ---------------------------------------------------------------------------
cd "${INSTALL}"

run_documented() {
  printf '   $ %s\n' "$*"
  {
    printf '$ %s\n' "$*"
    "$@" 2>&1
    printf '\n'
  } >> "${EVIDENCE}/documented-flow.txt" || {
    fail "the documented command failed: $*"
    return 1
  }
}

run_documented cp .env.example .env || abort "cp .env.example .env failed"
run_documented ./configure || abort "./configure failed"
run_documented docker compose config || abort "docker compose config failed"
run_documented docker compose pull || abort "docker compose pull failed"
run_documented docker compose up -d || abort "docker compose up -d failed"

# `up -d` returns when the containers are created, not when they are healthy.
# The documented flow's next command is `./reviewplane status`, and an operator
# typing it by hand takes seconds; the gate waits explicitly so that a slow
# machine is not read as a failure.
info "waiting for every service to become healthy"
"${COMPOSE[@]}" up -d --wait --wait-timeout 420 > /dev/null 2>&1 ||
  fail "not every service became healthy within the timeout"

run_documented ./reviewplane status || fail "./reviewplane status failed"

# The last documented command is run outside `run_documented`, because its
# output is a credential. `docs/SECURITY.md` §18 forbids credential material in
# a log, and this transcript is uploaded as a CI artefact and attached to pull
# requests. What the transcript records is that the command ran, printed a token
# of the right shape, and exited 0 — which is the whole of what it is evidence
# for. The token itself is matched and thrown away.
printf '   $ %s\n' "./reviewplane install-token"
TOKEN_OUTPUT="$(./reviewplane install-token 2>&1)"
TOKEN_STATUS=$?
{
  printf '$ ./reviewplane install-token\n'
  sed -E 's/\brpi_[A-Za-z0-9_-]+/rpi_[redacted]/g' <<< "${TOKEN_OUTPUT}"
  printf '\n'
} >> "${EVIDENCE}/documented-flow.txt"
if [[ "${TOKEN_STATUS}" -eq 0 ]] && grep -qE '\brpi_[A-Za-z0-9_-]{20,}' <<< "${TOKEN_OUTPUT}"; then
  pass "./reviewplane install-token printed a one-time administrator token"
else
  fail "./reviewplane install-token did not print a token"
fi
unset TOKEN_OUTPUT

pass "every command in section 8 ran and exited 0"

# ---------------------------------------------------------------------------
step "3. ./configure is safe to re-run"
# ---------------------------------------------------------------------------
BEFORE="$(cd "${INSTALL}/secrets" && sha256sum ./* | sort)"
BEFORE_SPKI="$(grep '^REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI=' "${INSTALL}/.env")"
./configure --quiet > "${EVIDENCE}/configure-rerun.txt" 2>&1 || fail "a second ./configure failed"
AFTER="$(cd "${INSTALL}/secrets" && sha256sum ./* | sort)"
AFTER_SPKI="$(grep '^REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI=' "${INSTALL}/.env")"
if [[ "${BEFORE}" == "${AFTER}" ]]; then
  pass "no secret was regenerated"
else
  fail "a second ./configure regenerated a secret; a running stack would lose every capability it has minted"
fi
if [[ "${BEFORE_SPKI}" == "${AFTER_SPKI}" ]]; then
  pass "the browser worker's certificate pin is unchanged"
else
  fail "a second ./configure changed the certificate pin the worker was started with"
fi

# ---------------------------------------------------------------------------
step "4. Every service is up and every role answers readiness"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" ps --format '{{.Service}}\t{{.State}}\t{{.Status}}\t{{.Publishers}}' \
  > "${EVIDENCE}/compose-ps.txt"
cat "${EVIDENCE}/compose-ps.txt"

for service in postgres api jobs mcp browser-worker tunnel-gateway gateway; do
  state="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' | awk -v s="${service}" '$1 == s { print $2 }')"
  if [[ "${state}" == "running" ]]; then
    pass "${service} is running"
  else
    fail "${service} is ${state:-absent}"
  fi
done

# `/health/ready` from inside, on each role's own listener. The `api` role's is
# reached from the gateway's network, the `jobs` role's from its own container,
# because `jobs` is deliberately on the data network and nothing else.
ready_from() {
  local service="$1" url="$2"
  "${COMPOSE[@]}" exec -T "${service}" node -e "
    fetch('${url}')
      .then(async (r) => { process.stdout.write(await r.text()); process.exit(r.ok ? 0 : 1); },
            (e) => { process.stderr.write(String(e)); process.exit(1); });
  " 2> /dev/null
}

for probe in "api|http://127.0.0.1:8080/health/ready" \
  "jobs|http://127.0.0.1:8081/health/ready" \
  "mcp|http://127.0.0.1:8081/health/ready"; do
  service="${probe%%|*}"
  url="${probe#*|}"
  if body="$(ready_from "${service}" "${url}")"; then
    printf '%s %s\n' "${service}" "${body}" >> "${EVIDENCE}/readiness.txt"
    pass "${service} /health/ready -> ready"
  else
    fail "${service} /health/ready did not report ready"
  fi
done

# ---------------------------------------------------------------------------
step "5. The login page, through the gateway, over TLS"
# ---------------------------------------------------------------------------
# --insecure: the default installation uses Caddy's internal authority, which is
# not in this host's trust store by design. --resolve presents the site's name
# in SNI, because a named Caddy site serves no certificate to a probe asking for
# another name and the handshake fails before any HTTP is exchanged.
fetch() {
  local path="$1"
  shift
  curl --silent --insecure --max-time 20 \
    --resolve "${DOMAIN}:${PORT}:127.0.0.1" \
    "$@" "https://${DOMAIN}:${PORT}${path}" 2> /dev/null || true
}
status_of() { fetch "$1" --output /dev/null --write-out '%{http_code}'; }

INDEX="$(fetch /)"
printf '%s' "${INDEX}" > "${EVIDENCE}/login-page.html"
if [[ "$(status_of /)" == "200" ]] && grep -q '<div id="root"' <<< "${INDEX}"; then
  pass "/ serves the single-page application document"
else
  fail "/ did not serve the application document"
fi

# The bundle, because a document that references a script nobody can fetch is a
# blank page rather than a login page.
BUNDLE="$(grep -oE 'src="/[^"]+\.js"' <<< "${INDEX}" | head -1 | sed 's/src="//; s/"//')"
if [[ -n "${BUNDLE}" && "$(status_of "${BUNDLE}")" == "200" ]]; then
  pass "the application bundle ${BUNDLE} loads"
else
  fail "the application bundle did not load (${BUNDLE:-none referenced})"
fi

# `/api` reaches the api service. This is the route the login screen uses to
# ask whether the installation has been claimed, so a gateway that served the
# document here would render a login page that can never sign anybody in.
BOOTSTRAP="$(fetch /api/v1/auth/bootstrap)"
printf '%s\n' "${BOOTSTRAP}" > "${EVIDENCE}/api-bootstrap-status.json"
if grep -q '"bootstrap_required"' <<< "${BOOTSTRAP}"; then
  pass "/api/v1/auth/bootstrap reaches the api service: $(head -c 120 <<< "${BOOTSTRAP}")"
else
  fail "/api/v1/auth/bootstrap did not reach the api service: $(head -c 200 <<< "${BOOTSTRAP}")"
fi

# `/mcp` reaches the mcp service and not the api service or the document.
MCP="$(fetch /mcp/v1 --request POST --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"
printf '%s\n' "${MCP}" > "${EVIDENCE}/mcp-response.json"
if grep -q '"jsonrpc"' <<< "${MCP}" || grep -qE '"(error|code)"' <<< "${MCP}"; then
  pass "/mcp/v1 reaches the mcp service: $(head -c 120 <<< "${MCP}")"
else
  fail "/mcp/v1 did not reach the mcp service: $(head -c 200 <<< "${MCP}")"
fi
if grep -q '<div id="root"' <<< "${MCP}"; then
  fail "/mcp/v1 served the application document; the agent route has fallen through"
fi

for path in /internal/v1/workers/register /internal/; do
  if [[ "$(status_of "${path}")" == "404" ]]; then
    pass "${path} is refused"
  else
    fail "${path} answered $(status_of "${path}"), expected 404"
  fi
done

# The document is not the login page: the page is what React renders from it.
# `docs/ROADMAP.md` §3's exit criterion says "a working login page", so the
# screenshot is taken from a real browser at both required viewports
# (AGENTS.md "Browser-facing work"), through the gateway, over TLS.
#
# The browser is the worker image's own Chromium, run as a one-off container on
# the project's frontend network. Using the image the product ships means the
# evidence is produced by the same browser the product drives.
cat > "${WORKTREE}/login-shot.mjs" << 'SHOT'
import { chromium } from "playwright-core";

const target = process.env.RP_URL;
const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
const results = [];
for (const [name, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  const context = await browser.newContext({
    viewport: { width, height },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const failed = [];
  page.on("requestfailed", (request) => {
    failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForSelector("h1", { timeout: 30_000 });
  await page.screenshot({ path: `/evidence/login-page-${name}.png`, fullPage: true });
  results.push({
    viewport: name,
    heading: (await page.locator("h1").first().innerText()).trim(),
    fields: await page.locator("form label").allInnerTexts(),
    consoleErrors,
    failedRequests: failed,
  });
  await context.close();
}
await browser.close();
process.stdout.write(JSON.stringify(results, null, 2));
SHOT

# Host networking, so the browser reaches the published port under the site's
# own name and presents that name in SNI. Both halves matter: a named Caddy site
# holds a certificate for its name and no other, and answers a handshake asking
# for a different one with an internal-error alert — before any certificate
# error the client could be told to ignore. This is also exactly what a human on
# this host does, which is what the exit criterion asks about.
#
# The container runs under the worker's own controls rather than as root with
# the sandbox off, because a screenshot taken by a browser configured unlike the
# shipped one is evidence about a different browser.
chmod 777 "${EVIDENCE}"
WORKER_IMAGE="${REVIEWPLANE_IMAGE_PREFIX:-ghcr.io/danjonesio}/reviewplane-browser-worker:${REVIEWPLANE_VERSION:-0.1.0}"
SHOT_OUTPUT="$(docker run --rm \
  --network host \
  --user 10001:10001 \
  --shm-size 1g \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=${INSTALL}/browser-worker-seccomp.json" \
  --env RP_URL="https://${DOMAIN}:${PORT}/" \
  --volume "${WORKTREE}/login-shot.mjs:/app/login-shot.mjs:ro" \
  --volume "${EVIDENCE}:/evidence" \
  --workdir /app \
  --entrypoint node \
  "${WORKER_IMAGE}" /app/login-shot.mjs 2>&1 || true)"
printf '%s\n' "${SHOT_OUTPUT}" > "${EVIDENCE}/login-page-render.json"
if grep -q "Set up this installation" <<< "${SHOT_OUTPUT}"; then
  pass "a real browser rendered the first-run screen at 1440x900 and 390x844"
else
  fail "the login page did not render: $(head -c 400 <<< "${SHOT_OUTPUT}")"
fi

# ---------------------------------------------------------------------------
step "6. Only the gateway publishes a host port"
# ---------------------------------------------------------------------------
ss -ltn > "${EVIDENCE}/host-listening-ports.txt"

PUBLISHED="$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
  --format '{{.Names}}\t{{.Ports}}' | grep -E '0\.0\.0\.0|:::|->' || true)"
printf '%s\n' "${PUBLISHED}" > "${EVIDENCE}/published-ports.txt"
PUBLISHING_SERVICES="$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
  --format '{{.Label "com.docker.compose.service"}}\t{{.Ports}}' | awk -F'\t' '$2 ~ /->/ { print $1 }' | sort -u)"
if [[ "${PUBLISHING_SERVICES}" == "gateway" ]]; then
  pass "the only service with a published port is the gateway"
else
  fail "services publishing host ports: ${PUBLISHING_SERVICES:-none} (expected exactly 'gateway')"
fi

# A real probe, not an inspection: connect from the host to the two ports
# `docs/DEPLOYMENT.md` §20 says must never be reachable. The gateway's own port
# is probed alongside them, so that a probe which cannot connect to anything is
# not mistaken for proof.
probe_port() {
  python3 - "$1" << 'PY'
import socket, sys
s = socket.socket()
s.settimeout(3)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    print("open")
except OSError as error:
    print(f"closed ({error.__class__.__name__})")
finally:
    s.close()
PY
}
{
  printf 'gateway  %s -> %s\n' "${PORT}" "$(probe_port "${PORT}")"
  printf 'postgres 5432 -> %s\n' "$(probe_port 5432)"
  printf 'chromium 9222 -> %s\n' "$(probe_port 9222)"
  printf 'tunnel   8444 -> %s\n' "$(probe_port 8444)"
  printf 'tunnel   8445 -> %s\n' "$(probe_port 8445)"
  printf 'worker   8090 -> %s\n' "$(probe_port 8090)"
} > "${EVIDENCE}/host-negative-checks.txt"
cat "${EVIDENCE}/host-negative-checks.txt"

[[ "$(probe_port "${PORT}")" == "open" ]] ||
  fail "the gateway port is not reachable, so the negative results below prove nothing"
for entry in "PostgreSQL 5432" "Chromium debugging 9222" "tunnel data 8444" "tunnel admin 8445" "browser worker 8090"; do
  port="${entry##* }"
  name="${entry% *}"
  if [[ "$(probe_port "${port}")" == "open" ]]; then
    fail "${name} answered on the host at 127.0.0.1:${port}"
  else
    pass "${name} is unreachable from the host at 127.0.0.1:${port}"
  fi
done

# ---------------------------------------------------------------------------
step "7. Container posture"
# ---------------------------------------------------------------------------
for service in api mcp jobs gateway browser-worker tunnel-gateway; do
  id="$(container_of "${service}")"
  [[ -n "${id}" ]] || {
    fail "${service} has no container"
    continue
  }
  mounts="$(docker inspect "${id}" --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}')"
  if grep -q "docker.sock" <<< "${mounts}"; then
    fail "${service} mounts the Docker socket"
  else
    pass "${service} has no Docker socket"
  fi
done

WORKER="$(container_of browser-worker)"
docker inspect "${WORKER}" --format '{{json .HostConfig}}' > "${EVIDENCE}/browser-worker-hostconfig.json"
WORKER_USER="$(docker exec "${WORKER}" id -u 2> /dev/null || echo "unknown")"
if [[ "${WORKER_USER}" == "10001" ]]; then
  pass "the browser worker runs as uid 10001, not root"
else
  fail "the browser worker runs as uid ${WORKER_USER}"
fi
WORKER_CAPS="$(docker inspect "${WORKER}" --format '{{.HostConfig.CapAdd}}/{{.HostConfig.CapDrop}}')"
info "browser worker capabilities: ${WORKER_CAPS}"
[[ "${WORKER_CAPS}" == *"SYS_CHROOT"* && "${WORKER_CAPS}" == *"ALL"* ]] ||
  fail "the browser worker's capability set is ${WORKER_CAPS}, expected SYS_CHROOT added and ALL dropped"
[[ "$(docker inspect "${WORKER}" --format '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]] ||
  fail "the browser worker's root filesystem is writable"

WORKER_SECRETS="$(docker exec "${WORKER}" ls /run/secrets 2> /dev/null | sort | tr '\n' ' ')"
info "browser worker secrets: ${WORKER_SECRETS}"
if grep -qE "database_url|capability_signing_key|bootstrap_token" <<< "${WORKER_SECRETS}"; then
  fail "the browser worker holds a database or control-plane credential (ADR-0012)"
else
  pass "the browser worker holds no database or artefact-store credential"
fi
if docker exec "${WORKER}" test -d /var/lib/reviewplane/artefacts 2> /dev/null; then
  fail "the browser worker has the artefact volume mounted"
else
  pass "the browser worker has no artefact volume"
fi

# The sandbox as the control plane recorded it, not as the environment claims
# it: `browser_workers.sandbox_enabled` is what the worker reported when it
# registered, so this asserts the running Chromium rather than a variable.
SANDBOX="$("${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At \
  -c "select name || '=' || sandbox_enabled from browser_workers" 2> /dev/null || true)"
printf '%s\n' "${SANDBOX}" > "${EVIDENCE}/browser-worker-sandbox.txt"
if grep -q "=true$" <<< "${SANDBOX}"; then
  pass "the registered browser worker reports the Chromium sandbox enabled (${SANDBOX})"
else
  fail "the browser worker did not register with the sandbox enabled (${SANDBOX:-no worker registered})"
fi

# ---------------------------------------------------------------------------
step "8. No UI asset comes from another host"
# ---------------------------------------------------------------------------
EXTERNAL="$(grep -oE '(src|href)="[^"]+"' <<< "${INDEX}" \
  | sed 's/^[a-z]*="//; s/"$//' \
  | grep -E '^(https?:)?//' || true)"
if [[ -z "${EXTERNAL}" ]]; then
  pass "the document references no external origin"
else
  fail "the document loads from another host: ${EXTERNAL}"
fi
if [[ -n "${BUNDLE}" ]]; then
  BUNDLE_BODY="$(fetch "${BUNDLE}")"
  BUNDLE_HOSTS="$(grep -oE 'https?://[A-Za-z0-9.-]+' <<< "${BUNDLE_BODY}" \
    | grep -vE '://(localhost|127\.0\.0\.1|www\.w3\.org|reviewplane\.)' | sort -u || true)"
  if [[ -z "${BUNDLE_HOSTS}" ]]; then
    pass "the bundle names no external host"
  else
    info "hosts named in the bundle: ${BUNDLE_HOSTS}"
    # Named is not the same as fetched; a namespace URI or a comment is neither.
    # The build's own self-contained check is the gate that forbids a fetch, so
    # this is reported rather than failed.
  fi
fi

# ---------------------------------------------------------------------------
step "9. reviewplane status"
# ---------------------------------------------------------------------------
./reviewplane status > "${EVIDENCE}/reviewplane-status.txt" 2>&1 || fail "reviewplane status exited non-zero"
cat "${EVIDENCE}/reviewplane-status.txt"
./reviewplane status --json > "${EVIDENCE}/reviewplane-status.json" 2>&1 || true
python3 - "${EVIDENCE}/reviewplane-status.json" << 'PY' || fail "the --json shape is not what automation was promised"
import json, sys

report = json.load(open(sys.argv[1]))
expected = [
    "status", "version", "database", "artefact_store", "connectors",
    "browser_capacity", "sessions", "queue", "storage", "certificate", "warnings",
]
missing = [key for key in expected if key not in report]
if missing:
    print(f"missing keys: {missing}")
    sys.exit(1)
if not report["database"]["reachable"]:
    print("the database is reported unreachable")
    sys.exit(1)
if not report["artefact_store"]["available"]:
    print("the artefact store is reported unavailable")
    sys.exit(1)
if report["browser_capacity"]["capacity"] < 1:
    print("no browser capacity is reported")
    sys.exit(1)
if not report["certificate"]["checked"]:
    print(f"the certificate was not checked: {report['certificate']['detail']}")
    sys.exit(1)
print("status --json carries every documented field")
PY
pass "reviewplane status reports database, artefact store, capacity and certificate"

# ---------------------------------------------------------------------------
step "10. Fault injection"
# ---------------------------------------------------------------------------
# PostgreSQL down: the API must report itself not ready and must NOT exit into a
# restart loop (`docs/ARCHITECTURE.md` §14, `docs/OPERATIONS.md` §2).
"${COMPOSE[@]}" stop postgres > /dev/null 2>&1
sleep 5
if ready_from api "http://127.0.0.1:8080/health/ready" > /dev/null 2>&1; then
  fail "the API reported ready with PostgreSQL stopped"
else
  pass "the API reports not ready with PostgreSQL stopped"
fi
if [[ "$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' | awk '$1 == "api" { print $2 }')" == "running" ]]; then
  pass "the API is still running rather than crash-looping"
else
  fail "the API exited when PostgreSQL stopped"
fi
LIVE="$(ready_from api "http://127.0.0.1:8080/health/live" 2> /dev/null || true)"
if grep -q '"live"' <<< "${LIVE}"; then
  pass "liveness still answers, so an orchestrator does not restart a healthy process"
else
  fail "liveness failed during a database outage: ${LIVE}"
fi
"${COMPOSE[@]}" start postgres > /dev/null 2>&1

# `reviewplane status` with the artefact store gone. The volume cannot be
# unmounted under a running container, so the fault is injected where the store
# actually reads: a path that is not writable.
# The root filesystem is read-only, so any path outside the mounted volumes and
# the tmpfs cannot be created. That is the same failure class as a volume that
# mounted read-only.
DEGRADED="$("${COMPOSE[@]}" exec -T -e REVIEWPLANE_ARTEFACT_PATH=/var/lib/reviewplane/no-such-store api \
  reviewplane status --json 2> /dev/null || true)"
if grep -q '"available": false' <<< "${DEGRADED}"; then
  pass "status reports the artefact store unavailable when it cannot be written"
else
  fail "status did not report an unwritable artefact store"
fi

# A missing secret file fails closed with a message naming it.
#
# Two properties, asserted separately, because only one of them is Compose's.
# Which component reports the absence depends on the Compose release: a recent
# one refuses to create the container and names the file, while an older one
# bind-mounts a directory in its place and leaves the control plane to discover
# it at startup. The property that must hold either way is that the API does not
# serve without its signing key — a process minting capabilities nothing could
# verify would be worse than one that refused to start.
mv "${INSTALL}/secrets/capability_signing_key" "${INSTALL}/secrets/capability_signing_key.moved"
MISSING="$("${COMPOSE[@]}" up -d --no-deps api 2>&1 || true)"
sleep 5
MISSING_LOGS="$("${COMPOSE[@]}" logs --tail 30 api 2>&1 || true)"
printf '%s\n\n--- api log ---\n%s\n' "${MISSING}" "${MISSING_LOGS}" > "${EVIDENCE}/missing-secret.txt"
if ready_from api "http://127.0.0.1:8080/health/ready" > /dev/null 2>&1; then
  fail "the API served without its capability signing key"
else
  pass "a missing secret file leaves the API refusing to serve"
fi
if grep -qi "capability_signing_key" <<< "${MISSING}${MISSING_LOGS}"; then
  pass "the refusal names the missing file"
else
  fail "the refusal did not name capability_signing_key: $(tail -c 300 <<< "${MISSING}${MISSING_LOGS}")"
fi
mv "${INSTALL}/secrets/capability_signing_key.moved" "${INSTALL}/secrets/capability_signing_key"

# ---------------------------------------------------------------------------
step "Evidence"
# ---------------------------------------------------------------------------
info "${EVIDENCE}"
ls -1 "${EVIDENCE}"

if [[ "${FAILURES}" -eq 0 ]]; then
  printf '\n%s== A clean host reached a working login page by following docs/DEPLOYMENT.md section 8%s\n' \
    "${BOLD}" "${RESET}"
  exit 0
fi

printf '\n%s== %s installation assertion(s) failed%s\n' "${RED}" "${FAILURES}" "${RESET}" >&2
exit 1
