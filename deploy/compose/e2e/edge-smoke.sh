#!/usr/bin/env bash
#
# The edge gateway, started and answered from outside.
#
# `docs/ARCHITECTURE.md` section 4.1 makes this the only component that
# publishes a host port and the only path a human reaches the product by, so
# every other suite runs behind it and none of them starts it. That gap is how
# a site address with no name — which binds the port, gives Caddy's internal
# authority no subject to issue for, and fails every TLS handshake — survived
# in a stack that otherwise passed end to end.
#
# So this gate is deliberately outside-in: it builds the real image, starts the
# real service under its real container controls, and talks to it over TLS
# through the published port exactly as a browser would. It asserts the four
# things the edge is responsible for on its own:
#
#   1. /healthz answers 200 over TLS.
#   2. / serves the web application's index.
#   3. /internal/* is refused, so a misconfigured network cannot turn into an
#      exposed browser-worker channel (`docs/API.md` section 15.1).
#   4. The security headers of `docs/SECURITY.md` are present, and the Server
#      header is not.
#
# It starts no upstream: `/api`, `/ws` and `/mcp` are proxy rules whose peers
# have their own suites, and the failure this gate exists to catch is in front
# of all three. `--no-deps` is what keeps it to one image and a few seconds.
#
# Usage: pnpm test:edge

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One project per run, as `run.sh` does: two runs on one machine must not share
# a container, a network or a volume.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-reviewplane-edge-$$-$(date +%s)}"
export COMPOSE_PROJECT_NAME
COMPOSE=(
  docker compose
  --project-name "${COMPOSE_PROJECT_NAME}"
  --project-directory "${COMPOSE_DIR}"
  -f "${COMPOSE_DIR}/compose.yaml"
)

# The site name. `localhost` is the compose default and the one the internal
# authority issues for; it is set explicitly here so the assertions state what
# they depend on.
DOMAIN="${REVIEWPLANE_GATEWAY_DOMAIN:-localhost}"
export REVIEWPLANE_GATEWAY_DOMAIN="${DOMAIN}"

# A free ephemeral host port, so two runs do not collide on 8443.
PORT="$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')"
export REVIEWPLANE_GATEWAY_PORT="${PORT}"

# compose.yaml interpolates this into the browser worker; the gateway does not
# read it, but Compose refuses to parse the file without it.
export REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI="${REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI:-edge-smoke-does-not-use-a-tunnel}"

# This gate builds the gateway image from the checkout rather than pulling the
# release, so the assertions describe the working tree. Set as an environment
# variable rather than in `.env`, because an operator's `.env` is theirs.
export REVIEWPLANE_PULL_POLICY=build

# The name compose.yaml pins the built image to. `docker compose config
# --images <service>` ignores the service argument and lists the whole file, so
# the name is derived here the same way compose.yaml derives it.
IMAGE_PREFIX="${REVIEWPLANE_IMAGE_PREFIX:-ghcr.io/danjonesio}"
IMAGE_VERSION="${REVIEWPLANE_VERSION:-0.1.0}"
GATEWAY_IMAGE="${IMAGE_PREFIX}/reviewplane-gateway:${IMAGE_VERSION}"

BOLD=$'\033[1m'
RED=$'\033[31m'
RESET=$'\033[0m'
FAILURES=0

step() { printf '\n%s== %s%s\n' "${BOLD}" "$1" "${RESET}"; }
info() { printf '   %s\n' "$1"; }
fail() {
  printf '%sFAILED: %s%s\n' "${RED}" "$1" "${RESET}" >&2
  FAILURES=$((FAILURES + 1))
}

cleanup() {
  "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Talks to the gateway the way a browser does: the name in SNI and in the Host
# header, resolved to the published loopback port. --insecure is the internal
# authority, which is not in the host's trust store by design; the assertion
# that matters is that the handshake completes at all, and a site with no
# subject name fails it before any byte of HTTP is exchanged.
fetch() {
  local path="$1"
  shift
  # `|| true`: a probe that cannot connect is an assertion failure to report,
  # not a reason to abandon the remaining checks. curl writes 000 for it.
  curl --silent --insecure --max-time 15 \
    --resolve "${DOMAIN}:${PORT}:127.0.0.1" \
    "$@" "https://${DOMAIN}:${PORT}${path}" 2>/dev/null || true
}

status_of() {
  fetch "$1" --output /dev/null --write-out '%{http_code}'
}

step "1. Build and start the edge gateway"
"${COMPOSE[@]}" build --quiet gateway || {
  fail "the gateway image did not build"
  exit 1
}
# --no-deps: the proxy peers are not part of what this gate asserts, and
# building them would make a seconds-long check a minutes-long one.
"${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 120 gateway || {
  fail "the gateway did not become healthy"
  "${COMPOSE[@]}" logs gateway | tail -40 >&2
  exit 1
}
info "gateway is up on 127.0.0.1:${PORT}, serving ${DOMAIN}"

step "2. The published port is reachable and TLS terminates"
# 000 is the one answer worth naming: it is what both of this gate's founding
# defects produced. A site address with no subject name fails the handshake
# with an internal-error alert, and a container on internal networks only never
# gets a port mapping at all. Neither shows up as an HTTP status.
HEALTH_STATUS="$(status_of /healthz)"
if [[ "${HEALTH_STATUS}" == "200" ]]; then
  info "/healthz -> 200 over TLS"
else
  fail "/healthz answered ${HEALTH_STATUS} (000 means the port or the handshake, not the route)"
fi

HEALTH_BODY="$(fetch /healthz)"
if [[ "${HEALTH_BODY}" == "ok" ]]; then
  info "/healthz body is the gateway's own answer, not an upstream's"
else
  fail "/healthz returned ${HEALTH_BODY@Q}, expected \"ok\""
fi

TLS_DETAIL="$(fetch /healthz --output /dev/null --write-out 'http/%{http_version} %{ssl_verify_result}')"
info "handshake completed (${TLS_DETAIL} — verify result 18 is the internal authority, by design)"

step "3. The web application is served"
INDEX_STATUS="$(status_of /)"
INDEX_BODY="$(fetch /)"
if [[ "${INDEX_STATUS}" == "200" ]]; then
  info "/ -> 200"
else
  fail "/ answered ${INDEX_STATUS}"
fi
if grep -q '<div id="root"' <<<"${INDEX_BODY}" && grep -qi '<script' <<<"${INDEX_BODY}"; then
  info "/ served the single-page application index with its bundle"
else
  fail "/ did not serve the web application index"
fi

# ADR-0011: routing is client-side, so an unknown path is the document.
DEEP_STATUS="$(status_of /reviews/bugs-on-homepage)"
if [[ "${DEEP_STATUS}" == "200" ]]; then
  info "an unknown path falls back to the document (client-side routing)"
else
  fail "a deep link answered ${DEEP_STATUS}, expected the document"
fi

step "4. The worker channel is refused"
for path in /internal/v1/workers/register /internal/v1/browser-sessions/brs_x/status /internal/; do
  INTERNAL_STATUS="$(status_of "${path}")"
  if [[ "${INTERNAL_STATUS}" == "404" ]]; then
    info "${path} -> 404"
  else
    fail "${path} answered ${INTERNAL_STATUS}, expected 404"
  fi
done

step "5. Security headers"
HEADERS="$(fetch / --head --output - | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
require_header() {
  local name="$1" expected="$2" line
  line="$(grep -i "^${name}:" <<<"${HEADERS}" || true)"
  if [[ -z "${line}" ]]; then
    fail "${name} is missing"
    return
  fi
  if [[ -n "${expected}" && "${line}" != *"${expected}"* ]]; then
    fail "${name} is ${line@Q}, expected it to contain ${expected@Q}"
    return
  fi
  info "${line}"
}

require_header "strict-transport-security" "max-age=31536000"
require_header "x-content-type-options" "nosniff"
require_header "x-frame-options" "deny"
require_header "referrer-policy" "no-referrer"
require_header "cross-origin-opener-policy" "same-origin"
require_header "cross-origin-resource-policy" "same-origin"
require_header "content-security-policy" "default-src 'self'"

if grep -qi "^server:" <<<"${HEADERS}"; then
  fail "the Server header is present; it is removed on purpose"
else
  info "no Server header"
fi

# The policy is only worth having because the bundle reaches no external host
# (ADR-0011); assert the two halves together.
if grep -q "frame-ancestors 'none'" <<<"${HEADERS}" && grep -q "object-src 'none'" <<<"${HEADERS}"; then
  info "content-security-policy still denies framing and objects"
else
  fail "content-security-policy lost frame-ancestors or object-src"
fi

step "6. The operator's own certificate is accepted"
# REVIEWPLANE_GATEWAY_TLS is the documented way an operator supplies their own
# certificate. A default that works and an override that does not is the same
# class of defect one level down, so the override is exercised rather than
# assumed — with a real certificate and key, under a real hostname, through the
# same adapter the server loads its configuration with.
TLS_DIR="$(mktemp -d)"
trap 'rm -rf "${TLS_DIR}"; cleanup' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=reviewplane.example.com" \
  -keyout "${TLS_DIR}/site.key" -out "${TLS_DIR}/site.crt" >/dev/null 2>&1

ESCAPE_HATCH="$(docker run --rm \
  --volume "${TLS_DIR}:/tls:ro" \
  --env REVIEWPLANE_GATEWAY_DOMAIN="reviewplane.example.com" \
  --env REVIEWPLANE_GATEWAY_TLS="/tls/site.crt /tls/site.key" \
  --entrypoint caddy \
  "${GATEWAY_IMAGE}" \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 || true)"

if grep -q "Valid configuration" <<<"${ESCAPE_HATCH}"; then
  info "an operator-supplied certificate and key are accepted under a named host"
else
  fail "REVIEWPLANE_GATEWAY_TLS with a certificate and key was refused"
fi
# The certificate is loaded rather than obtained: Caddy says so, and a
# deployment where it silently fell back to the internal authority would serve
# the wrong certificate under the operator's own name.
if grep -q "skipping automatic certificate management" <<<"${ESCAPE_HATCH}"; then
  info "the supplied certificate is used instead of the internal authority"
else
  fail "the supplied certificate was not loaded; Caddy would fall back to its own"
fi

step "7. Every proxy rule names a service that exists"
# The proxy peers are started by `pnpm test:install`, which drives `/api`,
# `/ws` and `/mcp` through this gateway to real upstreams. What this gate can
# assert without paying for those images is the failure that would make all
# three fall through to the single-page application document: an upstream named
# in the Caddyfile that is not a service in compose.yaml. Renaming a service and
# forgetting the routing file produces exactly that, and it looks like a working
# deployment until someone signs in.
SERVICES="$("${COMPOSE[@]}" config --services)"
while read -r upstream; do
  [[ -z "${upstream}" ]] && continue
  if grep -qx "${upstream}" <<< "${SERVICES}"; then
    info "reverse_proxy ${upstream} -> a service in compose.yaml"
  else
    fail "the Caddyfile proxies to ${upstream}, which is not a service in compose.yaml"
  fi
done < <(grep -oE 'reverse_proxy[[:space:]]+[A-Za-z0-9_-]+:[0-9]+' "${COMPOSE_DIR}/gateway/Caddyfile" \
  | awk '{print $2}' | cut -d: -f1 | sort -u)

if [[ "${FAILURES}" -eq 0 ]]; then
  printf '\n%s== The edge gateway serves the product over TLS%s\n' "${BOLD}" "${RESET}"
  exit 0
fi

printf '\n%s== %s edge assertion(s) failed%s\n' "${RED}" "${FAILURES}" "${RESET}" >&2
"${COMPOSE[@]}" logs gateway | tail -40 >&2
exit 1
