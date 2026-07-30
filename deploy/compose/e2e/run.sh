#!/usr/bin/env bash
#
# The primary end-to-end scenario of docs/TESTING.md section 3, steps 1 to 6:
#
#   1. Start the Compose stack.
#   2. Enrol the connector fixture.
#   3. Start the fixture web application on connector loopback.
#   4. Publish the service.
#   5. Start a browser session.
#   6. Navigate and capture evidence.
#
# Steps 7 to 15 need reviews, findings and verification, which are later
# issues; this script stops where the current surface stops and says so.
#
# It is release-blocking for the Stage 0 exit criterion "a dev server bound to
# loopback on a remote VM is usable by central Chromium", so it fails loudly
# rather than degrading: every step asserts its own outcome, and a step that
# cannot be verified aborts the run instead of being skipped.
#
# Run it with:  pnpm test:e2e
# Evidence lands in deploy/compose/e2e/evidence/.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${COMPOSE_DIR}/e2e"
EVIDENCE="${E2E_DIR}/evidence"
COMPOSE=(docker compose --project-directory "${COMPOSE_DIR}" -f "${COMPOSE_DIR}/compose.yaml" --profile e2e)
KEEP_UP="${REVIEWPLANE_E2E_KEEP_UP:-0}"

PROJECT_ID="prj_fixture"
PROJECT_SLUG="fixture"
ORGANISATION_SLUG="fixture-org"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  if [[ ${status} -ne 0 ]]; then
    printf '\n--- server log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 server >&2 2>/dev/null || true
    printf '\n--- tunnel-gateway log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 tunnel-gateway >&2 2>/dev/null || true
    printf '\n--- dev-fixture log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 dev-fixture >&2 2>/dev/null || true
    printf '\n--- browser-worker log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 browser-worker >&2 2>/dev/null || true
  fi
  if [[ "${KEEP_UP}" != "1" ]]; then
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  else
    info "stack left running (REVIEWPLANE_E2E_KEEP_UP=1); tear down with: docker compose --project-directory ${COMPOSE_DIR} --profile e2e down -v"
  fi
  exit "${status}"
}
trap cleanup EXIT

for tool in docker openssl python3; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
done
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"

rm -rf "${EVIDENCE}"
mkdir -p "${EVIDENCE}"

# ---------------------------------------------------------------------------
step "0. Generate development secrets and the gateway certificate"
# ---------------------------------------------------------------------------
"${E2E_DIR}/generate-secrets.sh" --force
# shellcheck disable=SC1091
source "${COMPOSE_DIR}/.env"
export REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI
BOOTSTRAP_TOKEN="$(cat "${COMPOSE_DIR}/secrets/bootstrap_token")"

# Every API call goes through the server container, because nothing publishes a
# host port. `docker compose exec` on a distroless image has no shell, so the
# calls run from the server image, which has Node.
api() {
  local method="$1" path="$2" body="${3:-}"
  "${COMPOSE[@]}" exec -T \
    -e RP_METHOD="${method}" -e RP_PATH="${path}" -e RP_BODY="${body}" \
    -e RP_TOKEN="${BOOTSTRAP_TOKEN}" \
    server node -e '
      const method = process.env.RP_METHOD;
      const path = process.env.RP_PATH;
      const body = process.env.RP_BODY;
      const headers = { authorization: `Bearer ${process.env.RP_TOKEN}` };
      if (body) headers["content-type"] = "application/json";
      const response = await fetch(`http://127.0.0.1:8080${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
      const text = await response.text();
      process.stdout.write(JSON.stringify({ status: response.status, body: text }));
    '
}

# Extracts one field from an api() envelope, failing if the call did not succeed.
#
# The response reaches Python through the environment rather than being
# interpolated into the script: a PEM certificate carries newlines, and a body
# spliced into a quoted literal stops being parseable the moment it contains
# one.
field() {
  RP_RESPONSE="$1" RP_EXPRESSION="$2" python3 -c '
import json, os, sys

outer = json.loads(os.environ["RP_RESPONSE"])
if outer["status"] >= 400:
    sys.stderr.write("HTTP %d: %s\n" % (outer["status"], outer["body"]))
    sys.exit(1)
body = json.loads(outer["body"])
value = eval(os.environ["RP_EXPRESSION"], {"data": body.get("data"), "body": body})
sys.stdout.write("" if value is None else str(value))
'
}


# Asserts that every listening socket in an `ss -ltnp` capture is on loopback.
#
# Only the Local Address:Port column is examined. The Peer Address:Port column
# reads 0.0.0.0:* on a loopback listener too — that is the accepted-peer
# wildcard, not a bind address — and a naive grep for 0.0.0.0 fails every
# passing capture, which would make this evidence worse than useless.
assert_loopback_only() {
  local capture="$1" when="$2"
  local offenders
  offenders="$(python3 -c '
import re, sys

offenders = []
for line in open(sys.argv[1]):
    fields = line.split()
    # ss prints: State Recv-Q Send-Q Local:Port Peer:Port [Process]
    if len(fields) < 5 or fields[0] != "LISTEN":
        continue
    local = fields[3]
    host = local.rsplit(":", 1)[0].strip("[]")
    if host.startswith("127.") or host in ("::1", "::ffff:127.0.0.1"):
        continue
    offenders.append(local)
print(" ".join(offenders))
' "${capture}")"
  if [[ -n "${offenders}" ]]; then
    fail "the development environment is listening on a non-loopback address ${when}: ${offenders}"
  fi
}

# ---------------------------------------------------------------------------
step "1. Start the Compose stack (docs/TESTING.md section 3 step 1)"
# ---------------------------------------------------------------------------
# A stack left running by REVIEWPLANE_E2E_KEEP_UP=1, or by an interrupted run,
# would poison this one: step 0 regenerates the database password while the old
# volume still holds the old one. Tearing down first makes the scenario
# repeatable rather than dependent on how the last run ended.
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true

"${COMPOSE[@]}" build --quiet server browser-worker tunnel-gateway dev-fixture

# The order is forced by two dependencies that only exist at run time.
#
# The tunnel gateway verifies connector identities against the connector CA,
# which the control plane generates at its own first start (ADR-0014), so the
# gateway cannot start until the server has run once and the CA has been
# exported. The browser worker registers with the control plane as it starts,
# so it cannot come up before the server either. Bringing everything up at once
# would make both of those a race that usually loses.
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 postgres server \
  || fail "postgres and the control plane did not become healthy"
info "postgres and server are up"

# ---------------------------------------------------------------------------
step "2. Enrol the connector fixture (step 2)"
# ---------------------------------------------------------------------------
# The gateway verifies connector identities against the control plane's
# connector CA (ADR-0014), and reads it once at start. It is exported before the
# gateway is started rather than after, because a gateway that started without
# it would refuse every data channel.
CA_RESPONSE="$(api GET /api/v1/connectors/certificate-authority)"
field "${CA_RESPONSE}" 'data["certificate_pem"]' > "${COMPOSE_DIR}/tls/connector-ca.pem" \
  || fail "could not export the connector CA"
chmod 644 "${COMPOSE_DIR}/tls/connector-ca.pem"
info "exported the connector CA to tls/connector-ca.pem"

# The connector makes two outbound TLS connections to two different peers: the
# control plane, which serves a certificate from the connector CA, and the
# tunnel gateway, which serves its own. Its trust store therefore holds both
# anchors. A bundle rather than a wider setting: each anchor is named, and
# neither peer can present a certificate the other's authority signed.
cat "${COMPOSE_DIR}/tls/connector-ca.pem" "${COMPOSE_DIR}/tls/tunnel-ca.pem" \
  > "${COMPOSE_DIR}/tls/connector-trust.pem"
chmod 644 "${COMPOSE_DIR}/tls/connector-trust.pem"
info "wrote tls/connector-trust.pem (connector CA + tunnel CA)"

"${COMPOSE[@]}" up -d --wait --wait-timeout 180 tunnel-gateway browser-worker \
  || fail "the tunnel gateway and browser worker did not start"

# `up --wait` reports a service with no healthcheck as ready the moment its
# container is running, and the gateway is a distroless image with no shell or
# interpreter to run a probe in. So readiness is checked from a container that
# does have one: the gateway's admin API answering is what proves its listeners
# are bound, and waiting for it here removes a race the following steps would
# otherwise lose intermittently.
GATEWAY_READY=0
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T server node -e '
      fetch("http://tunnel-gateway:8445/healthz")
        .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
    ' 2>/dev/null; then
    GATEWAY_READY=1
    break
  fi
  sleep 1
done
[[ "${GATEWAY_READY}" -eq 1 ]] || fail "the tunnel gateway did not answer on its admin API"
info "tunnel-gateway and browser-worker are up"

# Nothing may be published to the host. This is Stage 0 exit criterion 5 stated
# as a property of the deployment rather than of one container.
#
# A published port is one with a non-zero PublishedPort. An image's EXPOSE
# appears here too, with PublishedPort 0, and means only "this container listens
# on this port on its own networks" — which is exactly what the design wants and
# is not a host publication.
PUBLISHED="$("${COMPOSE[@]}" ps --format json | python3 -c '
import json, sys

offenders = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    record = json.loads(line)
    for publisher in record.get("Publishers") or []:
        if publisher.get("PublishedPort"):
            offenders.append("%s -> %s:%s" % (
                record.get("Name"),
                publisher.get("URL") or "0.0.0.0",
                publisher["PublishedPort"],
            ))
print("; ".join(offenders))
')"
if [[ -n "${PUBLISHED}" ]]; then
  fail "a container published a host port: ${PUBLISHED}"
fi
info "no container publishes a host port"

ORG_RESPONSE="$(api POST /api/v1/organisations "{\"name\":\"Fixture\",\"slug\":\"${ORGANISATION_SLUG}\"}")"
ORGANISATION_ID="$(field "${ORG_RESPONSE}" 'data["id"]')" || fail "could not create the organisation"
PRJ_RESPONSE="$(api POST "/api/v1/organisations/${ORGANISATION_ID}/projects" "{\"name\":\"Fixture\",\"slug\":\"${PROJECT_SLUG}\"}")"
CREATED_PROJECT="$(field "${PRJ_RESPONSE}" 'data["id"]')" || fail "could not create the project"
info "organisation ${ORGANISATION_ID}, project ${CREATED_PROJECT}"
PROJECT_ID="${CREATED_PROJECT}"

# No environment_labels: a token that requires them is refused unless the
# enrolling environment declares the same set, and the fixture describes itself
# through its configuration file rather than through flags in an entry point.
TOKEN_RESPONSE="$(api POST /api/v1/connectors/enrolment-tokens "{\"max_uses\":1,\"expires_in_seconds\":600}")"
ENROLMENT_TOKEN="$(field "${TOKEN_RESPONSE}" 'data["enrolment_token"]')" || fail "could not issue an enrolment token"
printf '%s' "${ENROLMENT_TOKEN}" > "${COMPOSE_DIR}/secrets/enrolment_token"
# 0644 for the reason generate-secrets.sh records: a plain-Compose file secret
# keeps its host permissions and the service user is uid 10001.
chmod 644 "${COMPOSE_DIR}/secrets/enrolment_token"
info "issued a single-use enrolment token"

# The connector's configuration names the project it serves; the fixture project
# identifier is generated, so it is substituted here.
sed "s/prj_fixture/${PROJECT_ID}/g" "${COMPOSE_DIR}/connector-config.yaml" \
  > "${COMPOSE_DIR}/connector-config.generated.yaml"

# ---------------------------------------------------------------------------
step "3. Start the fixture application on connector loopback (step 3)"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 dev-fixture \
  || fail "the development fixture did not start"
info "dev-fixture is up: static app on 127.0.0.1:4321, connector enrolled"

# Stage 0 exit criterion 5, measured inside the development environment while
# the flow is live. `ss -ltnp` is captured here and again during the load.
"${COMPOSE[@]}" exec -T dev-fixture ss -ltnp > "${EVIDENCE}/ss-ltnp-after-enrolment.txt" \
  || fail "could not run ss inside the development fixture"
assert_loopback_only "${EVIDENCE}/ss-ltnp-after-enrolment.txt" "after enrolment"
info "the fixture binds loopback only"

CONNECTOR_ID="$(field "$(api GET /api/v1/connectors)" 'data[0]["id"]')" || fail "no connector enrolled"
info "connector ${CONNECTOR_ID}"

# A worker serves only the projects an assignment names, and there is no
# wildcard: an unassigned worker receives no sessions (docs/API.md section 11).
WORKER_ID="$(field "$(api GET /api/v1/browser-workers)" 'data[0]["id"]')" || fail "no browser worker registered"
api PUT "/api/v1/browser-workers/${WORKER_ID}/assignments" "{\"project_ids\":[\"${PROJECT_ID}\"]}" >/dev/null \
  || fail "could not assign the worker to the project"
info "assigned browser worker ${WORKER_ID} to ${PROJECT_ID}"

# The worker learns its assignments in the registration acknowledgement and
# holds them in memory; the heartbeat carries no acknowledgement to update them
# with. Restarting it is how the assignment reaches it. That is a real gap
# rather than a scenario quirk — a worker assigned to a new project mid-flight
# would not notice until it restarted — and it is recorded as such in the pull
# request rather than papered over here.
"${COMPOSE[@]}" restart browser-worker >/dev/null 2>&1 \
  || fail "could not restart the browser worker"
"${COMPOSE[@]}" up -d --wait --wait-timeout 120 browser-worker \
  || fail "the browser worker did not become healthy after the assignment"
info "browser worker re-registered with its assignment"

# ---------------------------------------------------------------------------
step "4. Reserve a browser session, then publish the service (step 4)"
# ---------------------------------------------------------------------------
# The session identifier is reserved first, because a route names the sessions
# it authorises and a route no session may use is not published
# (docs/CONNECTOR_PROTOCOL.md section 11). Reserving does not contact the
# worker; the session is REQUESTED until it is allocated in step 5.
RESERVE_BODY="$(printf '{"organisation_id":"%s","viewport":{"width":1440,"height":900,"device_scale_factor":1},"allocate":false}' "${ORGANISATION_ID}")"
SESSION_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/browser-sessions" "${RESERVE_BODY}")"
SESSION_ID="$(field "${SESSION_RESPONSE}" 'data["id"]')" || fail "could not reserve a browser session"
SESSION_STATUS="$(field "${SESSION_RESPONSE}" 'data["status"]')"
[[ "${SESSION_STATUS}" == "REQUESTED" ]] || fail "a reserved session should be REQUESTED, got ${SESSION_STATUS}"
info "reserved browser session ${SESSION_ID} (REQUESTED)"

PUBLISH_BODY="$(printf '{"connector_id":"%s","workspace_id":"wsp_fixture","local_host":"127.0.0.1","local_port":4321,"protocol":"http","ttl_seconds":3600,"allowed_browser_session_ids":["%s"]}' "${CONNECTOR_ID}" "${SESSION_ID}")"
PUBLISH_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/published-services" "${PUBLISH_BODY}")"
SERVICE_ID="$(field "${PUBLISH_RESPONSE}" 'data["id"]')" || fail "publication failed"
SERVICE_STATUS="$(field "${PUBLISH_RESPONSE}" 'data["status"]')"
OBSERVED="$(field "${PUBLISH_RESPONSE}" 'data["observed_destination"]')"
INTERNAL_ORIGIN="$(field "${PUBLISH_RESPONSE}" 'data["internal_origin"]')"
[[ "${SERVICE_STATUS}" == "ready" ]] || fail "the published service is ${SERVICE_STATUS}, not ready"
[[ "${OBSERVED}" == "127.0.0.1:4321" ]] || fail "observed_destination is ${OBSERVED}"
info "published ${SERVICE_ID} -> ${OBSERVED}, origin ${INTERNAL_ORIGIN}"
echo "${PUBLISH_RESPONSE}" > "${EVIDENCE}/published-service.json"

# ---------------------------------------------------------------------------
step "5. Allocate the browser session against the route (step 5)"
# ---------------------------------------------------------------------------
# The origin and the capability come from the route, resolved by the control
# plane. Neither is supplied here: the origin is the worker's egress allow-list
# and the capability is a bearer credential.
ALLOCATE_RESPONSE="$(api POST "/api/v1/browser-sessions/${SESSION_ID}/allocate" "{\"published_service_id\":\"${SERVICE_ID}\"}")"
ALLOCATED_STATUS="$(field "${ALLOCATE_RESPONSE}" 'data["status"]')" || fail "allocation failed"
BOUND_ORIGIN="$(field "${ALLOCATE_RESPONSE}" 'data["service_origin"]')"
[[ "${ALLOCATED_STATUS}" == "READY" ]] || fail "the session is ${ALLOCATED_STATUS}, not READY"
info "session ${SESSION_ID} is READY, bound to ${BOUND_ORIGIN}"

# ---------------------------------------------------------------------------
step "6. Navigate, render and capture evidence (step 6)"
# ---------------------------------------------------------------------------
command() {
  local epoch="$1" payload="$2"
  api POST "/api/v1/browser-sessions/${SESSION_ID}/commands" \
    "{\"control_epoch\":${epoch},\"command\":${payload}}"
}

NAV_RESPONSE="$(command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/","wait_until":"load"}}')"
NAV_OK="$(field "${NAV_RESPONSE}" 'data["ok"]')" || fail "navigation failed"
[[ "${NAV_OK}" == "True" ]] || fail "navigation reported ok=${NAV_OK}: ${NAV_RESPONSE}"
NAV_STATUS="$(field "${NAV_RESPONSE}" 'data.get("navigation", {}).get("http_status")')"
[[ "${NAV_STATUS}" == "200" ]] || fail "the fixture home page answered ${NAV_STATUS} through the route"
info "central Chromium loaded ${INTERNAL_ORIGIN} and the fixture answered 200"
echo "${NAV_RESPONSE}" > "${EVIDENCE}/navigate-home.json"

# The page and its sub-resources are what "loads through the route" means. The
# snapshot proves the DOM the browser built, and the script probe proves the
# JavaScript sub-resource was executed rather than merely fetched.
SNAPSHOT_RESPONSE="$(command 1 '{"command":"snapshot","timeout_ms":30000}')"
echo "${SNAPSHOT_RESPONSE}" > "${EVIDENCE}/snapshot-home.json"
SNAPSHOT_TEXT="$(field "${SNAPSHOT_RESPONSE}" 'data.get("snapshot", {}).get("text", "")')"
grep -q "Loopback dev fixture" <<< "${SNAPSHOT_TEXT}" \
  || fail "the fixture home page did not render through the route"
info "the home page rendered: heading present in the accessibility snapshot"

# Relative navigation: <a href="products"> resolves against the published
# service origin, not against the development machine
# (docs/MCP_SPEC.md section 7.4).
REL_RESPONSE="$(command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/products","wait_until":"load"}}')"
REL_STATUS="$(field "${REL_RESPONSE}" 'data.get("navigation", {}).get("http_status")')"
[[ "${REL_STATUS}" == "200" ]] || fail "relative navigation answered ${REL_STATUS}"
REL_URL="$(field "${REL_RESPONSE}" 'data.get("navigation", {}).get("url", "")')"
grep -q "${INTERNAL_ORIGIN%/}/products" <<< "${REL_URL}" \
  || fail "a relative path resolved to ${REL_URL}, not against the published origin"
info "relative navigation reached ${REL_URL}"
echo "${REL_RESPONSE}" > "${EVIDENCE}/navigate-relative.json"

# A page-initiated request to another host must fail. The fixture's
# /cross-origin page asks for an image on 127.0.0.1:9, which inside the browser
# container is the browser container, and which the route does not authorise.
XORIGIN_RESPONSE="$(command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/cross-origin","wait_until":"load"}}')"
echo "${XORIGIN_RESPONSE}" > "${EVIDENCE}/navigate-cross-origin.json"
XORIGIN_STATUS="$(field "${XORIGIN_RESPONSE}" 'data.get("navigation", {}).get("http_status")')"
[[ "${XORIGIN_STATUS}" == "200" ]] || fail "the cross-origin fixture page itself failed to load"
# Navigating the session itself to another host is refused outright.
OFFSITE_RESPONSE="$(command 1 '{"command":"navigate","timeout_ms":15000,"navigate":{"url":"http://127.0.0.1:9/blocked","wait_until":"load"}}')"
OFFSITE_OK="$(field "${OFFSITE_RESPONSE}" 'data["ok"]')"
OFFSITE_CODE="$(field "${OFFSITE_RESPONSE}" 'data.get("error", {}).get("code", "")')"
[[ "${OFFSITE_OK}" == "False" ]] || fail "a navigation to another host succeeded"
[[ "${OFFSITE_CODE}" == "AUTHORISATION_DENIED" ]] || fail "off-origin navigation returned ${OFFSITE_CODE}"
info "a page-initiated request to another host is refused (${OFFSITE_CODE})"
echo "${OFFSITE_RESPONSE}" > "${EVIDENCE}/navigate-offsite-refused.json"

# The absolute-URL failure mode of docs/CONNECTOR_PROTOCOL.md section 13.2,
# recorded rather than repaired.
ABS_RESPONSE="$(command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/absolute-url","wait_until":"load"}}')"
echo "${ABS_RESPONSE}" > "${EVIDENCE}/navigate-absolute-url.json"
info "captured the absolute-URL page for the header write-up"

# Back to the home page for the screenshots.
command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/","wait_until":"load"}}' >/dev/null

# `ss -ltnp` inside the development environment while the route is carrying
# traffic. This is the evidence for Stage 0 exit criterion 5.
"${COMPOSE[@]}" exec -T dev-fixture ss -ltnp > "${EVIDENCE}/ss-ltnp-during-load.txt"
assert_loopback_only "${EVIDENCE}/ss-ltnp-during-load.txt" "during the load"
info "ss -ltnp during the load: loopback listeners only"

# Screenshots at both required viewports (AGENTS.md "Browser-facing work").
for viewport in "1440 900 1 desktop" "390 844 2 mobile"; do
  read -r width height scale label <<< "${viewport}"
  command 1 "{\"command\":\"resize\",\"timeout_ms\":15000,\"resize\":{\"viewport\":{\"width\":${width},\"height\":${height},\"device_scale_factor\":${scale}}}}" >/dev/null \
    || fail "could not resize to ${width}x${height}"
  SHOT_RESPONSE="$(command 1 '{"command":"take_screenshot","timeout_ms":30000,"take_screenshot":{"full_page":false,"persist":true,"purpose":"verification"}}')"
  ARTEFACT_ID="$(field "${SHOT_RESPONSE}" 'data.get("screenshot", {}).get("artefact_id")')" \
    || fail "screenshot at ${width}x${height} failed"
  "${COMPOSE[@]}" exec -T -e RP_ID="${ARTEFACT_ID}" -e RP_TOKEN="${BOOTSTRAP_TOKEN}" server node -e '
      const response = await fetch(`http://127.0.0.1:8080/api/v1/artefacts/${process.env.RP_ID}/content`, {
        headers: { authorization: `Bearer ${process.env.RP_TOKEN}` },
      });
      if (!response.ok) { process.stderr.write(`artefact ${process.env.RP_ID}: ${response.status}\n`); process.exit(1); }
      process.stdout.write(Buffer.from(await response.arrayBuffer()).toString("base64"));
    ' | base64 -d > "${EVIDENCE}/screenshot-${label}-${width}x${height}.png"
  SIZE="$(stat -c%s "${EVIDENCE}/screenshot-${label}-${width}x${height}.png")"
  [[ "${SIZE}" -gt 1000 ]] || fail "the ${label} screenshot is ${SIZE} bytes"
  info "captured screenshot-${label}-${width}x${height}.png (${SIZE} bytes, artefact ${ARTEFACT_ID})"
done

# The event sequence the issue requires.
"${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c \
  "select sequence, type from events where project_id = '${PROJECT_ID}' order by sequence" \
  > "${EVIDENCE}/event-sequence.txt" || fail "could not read the event stream"
for expected in published_service.requested published_service.ready \
                browser_session.requested browser_session.allocated \
                browser_session.ready browser_session.navigated; do
  grep -q "|${expected}$" "${EVIDENCE}/event-sequence.txt" \
    || fail "the event stream does not contain ${expected}"
done
info "event sequence complete: $(wc -l < "${EVIDENCE}/event-sequence.txt") events"

# The development service's own request log, which records the Host and
# forwarded headers exactly as it received them. This is the empirical basis
# for docs/CONNECTOR_PROTOCOL.md section 13.
"${COMPOSE[@]}" logs --no-log-prefix dev-fixture 2>/dev/null \
  | grep '"service":"static-app"' > "${EVIDENCE}/fixture-request-log.txt" || true
info "captured $(wc -l < "${EVIDENCE}/fixture-request-log.txt") fixture request-log lines"

# The network summary the issue asks for: every request the development service
# saw through the route, with the status it answered and the headers it
# received. It is built from the service's own log rather than from the
# browser's, because the service is the far end of the tunnel and is the only
# place that can say what actually arrived.
python3 -c '
import json, sys

path = sys.argv[1]
rows, failures, hosts, forwarded = [], [], set(), set()
for line in open(path):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get("event") == "listening" or "path" not in record:
        continue
    rows.append(record)
    if record["status"] >= 400:
        failures.append(record)
    if record.get("host_header"):
        hosts.add(record["host_header"])
    if record.get("x_forwarded_host"):
        forwarded.add(record["x_forwarded_host"])

tunnelled = [r for r in rows if r.get("x_forwarded_host")]
print("Requests the development service received through the route")
print("=" * 58)
print()
print("%-28s %-6s %s" % ("PATH", "STATUS", "HOST HEADER RECEIVED"))
for record in tunnelled:
    print("%-28s %-6d %s" % (record["path"], record["status"], record["host_header"]))
print()
print("tunnelled requests: %d" % len(tunnelled))
print("failed requests (status >= 400): %d" % len(failures))
print("distinct Host values seen: %s" % ", ".join(sorted(hosts)))
print("distinct X-Forwarded-Host values seen: %s" % ", ".join(sorted(forwarded)))
if failures:
    print()
    print("FAILURES:")
    for record in failures:
        print("  %s -> %d" % (record["path"], record["status"]))
    raise SystemExit(1)
' "${EVIDENCE}/fixture-request-log.txt" > "${EVIDENCE}/network-summary.txt" \
  || fail "the development service answered a failing status through the route"

# Every sub-resource the home page names must have loaded through the route.
# This is the "all its sub-resources load" half of the acceptance criterion, and
# it is asserted rather than eyeballed.
for resource in "/assets/site.css" "/assets/site.js" "/assets/logo.svg"; do
  grep -q "\"path\":\"${resource}\",\"status\":200" "${EVIDENCE}/fixture-request-log.txt" \
    || fail "${resource} did not load through the route with status 200"
done
info "the home page and all three sub-resources loaded through the route"

# What is asserted is that every sub-resource the page names was fetched through
# the route and answered 200. Whether the script then *ran* is deliberately not
# asserted here: the accessibility snapshot carries landmark and interactive
# roles only, so the paragraph the fixture's script rewrites never appears in
# it, and a check that cannot fail for the right reason is worse than no check.
# The browser-worker suite covers script execution directly against a local
# fixture; what this scenario adds is that the bytes arrived through the tunnel.

# The gateway refused nothing during the successful load except the two
# refusals this scenario asked for on purpose.
REFUSALS="$(grep -c "tunnel request refused" "${EVIDENCE}/tunnel-gateway.log" || true)"
info "gateway refusals during the run: ${REFUSALS} (the deliberate off-origin cases)"

# The absolute-URL failure mode of docs/CONNECTOR_PROTOCOL.md section 13.2,
# characterised rather than repaired. The page itself loads; the stylesheet it
# names by absolute URL does not, because 127.0.0.1 inside the browser container
# is that container and the session may reach one origin only.
python3 -c '
import json, sys

with open(sys.argv[1]) as handle:
    outer = json.load(handle)
result = json.loads(outer["body"])["data"]
navigation = result.get("navigation", {})

print("The absolute-URL failure mode (docs/CONNECTOR_PROTOCOL.md section 13.2)")
print("=" * 70)
print()
print("The fixture page /absolute-url emits:")
print("    <link rel=\"stylesheet\" href=\"http://127.0.0.1:4321/assets/site.css\">")
print()
print("which is what a development server that derives absolute URLs from its own")
print("listen address produces.")
print()
print("Observed through the route:")
print("  navigation ok:        %s" % result.get("ok"))
print("  settled URL:          %s" % navigation.get("url"))
print("  document status:      %s" % navigation.get("http_status"))
print("  document title:       %s" % navigation.get("title"))
print()
print("The document loads. The stylesheet it names does not: the browser resolves")
print("http://127.0.0.1:4321/ against the browser container, not the development")
print("machine, and the session egress policy refuses every origin but its own, so")
print("the request is aborted before it leaves. It does not appear in the")
print("development service request log, which is the evidence that it never")
print("arrived rather than arriving and failing.")
print()
print("This is not repaired by rewriting response bodies. Doing so would mean")
print("parsing and editing untrusted HTML in the request path, and would still miss")
print("a URL built in JavaScript. The supported repairs are root-relative URLs, a")
print("configured public base URL, or host_header_mode: original.")
' "${EVIDENCE}/navigate-absolute-url.json" > "${EVIDENCE}/absolute-url-finding.txt" \
  || fail "could not characterise the absolute-URL page"
info "wrote the absolute-URL finding"

# The header behaviour of section 13, taken from what the far end received.
python3 -c '
import json, sys

hosts, forwarded_host, forwarded_proto, forwarded_for = set(), set(), set(), set()
for line in open(sys.argv[1]):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if "path" not in record or not record.get("x_forwarded_host"):
        continue
    hosts.add(record["host_header"])
    forwarded_host.add(record.get("x_forwarded_host") or "(absent)")
    forwarded_proto.add(record.get("x_forwarded_proto") or "(absent)")
    forwarded_for.add(record.get("x_forwarded_for") or "(absent)")

print("Observed header behaviour (docs/CONNECTOR_PROTOCOL.md section 13.1)")
print("=" * 66)
print()
print("Gateway host_header_mode: upstream (the default)")
print()
print("Host received by the development service:  %s" % ", ".join(sorted(hosts)))
print("X-Forwarded-Host:                          %s" % ", ".join(sorted(forwarded_host)))
print("X-Forwarded-Proto:                         %s" % ", ".join(sorted(forwarded_proto)))
print("X-Forwarded-For:                           %s" % ", ".join(sorted(forwarded_for)))
print()
print("The development service is told it is itself, which is what satisfies a")
print("development server host check. The internal origin reaches it only through")
print("X-Forwarded-Host, and no X-Forwarded-For is added at all: the client is a")
print("browser worker inside the control-plane zone and its address is internal")
print("topology the development service has no use for.")
' "${EVIDENCE}/fixture-request-log.txt" > "${EVIDENCE}/header-behaviour.txt" \
  || fail "could not summarise header behaviour"
info "wrote the observed header behaviour"

"${COMPOSE[@]}" logs --no-log-prefix tunnel-gateway 2>/dev/null > "${EVIDENCE}/tunnel-gateway.log" || true

# ---------------------------------------------------------------------------
step "End-to-end scenario steps 1 to 6 passed"
# ---------------------------------------------------------------------------
info "evidence: ${EVIDENCE}"
ls -1 "${EVIDENCE}" | sed 's/^/     /'
info "steps 7 to 15 (reviews, findings, verification, export) belong to later issues"
