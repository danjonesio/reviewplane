#!/usr/bin/env bash
#
# The primary end-to-end scenario of docs/TESTING.md section 3, all fifteen
# steps, against the shipped Compose deployment:
#
#   1. Start the Compose stack.
#   2. Enrol the connector fixture.
#   3. Start the fixture web application on connector loopback, and observe the
#      development machine's checkout (steps 3a and 3b below).
#   4. Publish the service.
#   5. Start a browser session.
#   6. Navigate and capture evidence.
#   7. A human test client creates the named review `bugs-on-homepage`.
#   8. It creates an annotated finding in it, against the captured screenshot.
#   9. An agent fixture, speaking MCP as a real client over the local stdio
#      bridge, retrieves and claims it.
#  10. The agent changes the application on the development machine.
#  11. It captures the after screenshot.
#  12. It submits verification and hands the finding to a human.
#  13. A **human** accepts, with human credentials.
#  14. `reviewplane export-review` writes the portable document.
#  15. The event sequence and the artefact hashes are asserted.
#
# Steps 7, 8 and 13 use a real account: `POST /api/v1/auth/bootstrap` claims the
# installation with the install token and `POST /api/v1/auth/sessions` signs in,
# and every write then carries the session cookie and its CSRF header. That is
# not decoration. The bootstrap operator token this script uses everywhere else
# is a principal with `organisationId: null` **and** `projectIds: null`, so every
# tenancy term in every scoped query goes vacuous under it and an acceptance
# driven by it would pass while proving nothing about who may accept
# (`docs/TESTING.md` §10, "The organisation-wide session is the probe").
#
# It also proves the tunnel capabilities `docs/ARCHITECTURE.md` section 7.4
# makes mandatory, which the numbered scenario does not reach. These are
# numbered T1 to T3 rather than 7 to 9 because they are **not** steps of that
# scenario — they are the capabilities the route has to have for the scenario to
# mean anything, and sharing its numbering made two different things look like
# one list:
#
#   T1. A WebSocket echo and server-sent events through the route.
#   T2. Vite hot module replacement: a source edit on the development machine
#       applied in central Chromium without a full page reload.
#   T3. The performance baseline of `docs/TESTING.md` section 12.
#
# It is release-blocking, so it fails loudly rather than degrading: every step
# asserts its own outcome, and a step that cannot be verified aborts the run
# instead of being skipped.
#
# Run it with:  pnpm test:e2e
# Evidence lands in deploy/compose/e2e/evidence/.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${COMPOSE_DIR}/e2e"
EVIDENCE="${E2E_DIR}/evidence"

# The Compose project name is unique per run unless the caller fixes it.
#
# `compose.yaml` names the project `reviewplane`, which is right for a
# deployment and wrong for a test: two runs on one machine would share
# containers, networks and volumes, and the second would tear down the first's
# stack mid-flight. A per-run name gives each run its own everything, including
# its own database volume — which also removes the reason the old script had to
# tear down a previous stack before starting, since step 0 regenerates the
# database password and a fresh volume never holds the old one.
#
# COMPOSE_PROJECT_NAME is honoured when it is set, so a caller who wants a
# predictable name for debugging can have one.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-reviewplane-e2e-$$-$(date +%s)}"
export COMPOSE_PROJECT_NAME
COMPOSE=(
  docker compose
  --project-name "${COMPOSE_PROJECT_NAME}"
  --project-directory "${COMPOSE_DIR}"
  -f "${COMPOSE_DIR}/compose.yaml"
  --profile development
)
KEEP_UP="${REVIEWPLANE_E2E_KEEP_UP:-0}"

PROJECT_ID="prj_fixture"
PROJECT_SLUG="fixture"

# The human account this run creates and signs in as. The password is a fixture
# value for a disposable installation and is not a credential to anything that
# outlives the run; the installation token it is claimed with is minted by
# `reviewplane install-token` at step 7 and is single-use.
HUMAN_EMAIL="reviewer@fixture.invalid"
HUMAN_PASSWORD="correct horse battery staple"
REVIEW_SLUG="bugs-on-homepage"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  local status=$?
  if [[ ${status} -ne 0 ]]; then
    printf '\n--- api log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 api >&2 2>/dev/null || true
    printf '\n--- tunnel-gateway log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 tunnel-gateway >&2 2>/dev/null || true
    printf '\n--- dev-fixture log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 dev-fixture >&2 2>/dev/null || true
    printf '\n--- browser-worker log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 browser-worker >&2 2>/dev/null || true
    printf '\n--- mcp log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 60 mcp >&2 2>/dev/null || true
    printf '\n--- gateway log (tail) ---\n' >&2
    "${COMPOSE[@]}" logs --tail 40 gateway >&2 2>/dev/null || true
  fi
  if [[ "${KEEP_UP}" != "1" ]]; then
    # Teardown names this run's project explicitly. Without the name it would
    # target whatever project the compose file declares, which is another run's.
    "${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  else
    info "stack left running (REVIEWPLANE_E2E_KEEP_UP=1); tear down with:"
    info "  docker compose --project-name ${COMPOSE_PROJECT_NAME} --project-directory ${COMPOSE_DIR} --profile development down -v"
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

# The edge gateway is part of this run, because `/mcp/v1` is a route on it
# (`docs/ARCHITECTURE.md` §4.1) and step 9's bridge posts JSON-RPC there.
#
# Two supported knobs are set for it, and neither changes what is under test.
# The site is served under the name the development environment reaches it by,
# because a certificate is issued for the site address and the connector
# verifies the name it dialled — a gateway serving `localhost:8443` matches no
# request for `gateway:8443` and answers nothing at all. And the host port is
# left to the kernel: nothing in this scenario opens the published port, and a
# fixed one would make two concurrent runs on one machine collide on a bind
# rather than on anything real.
#
# **After** the `source` above, deliberately. `configure` writes both values
# into `.env`, so an export before it is silently replaced by `localhost:8443`
# and the gateway comes up under a name nothing in this run is dialling.
export REVIEWPLANE_GATEWAY_DOMAIN="gateway"
export REVIEWPLANE_GATEWAY_PORT="0"
BOOTSTRAP_TOKEN="$(cat "${COMPOSE_DIR}/secrets/bootstrap_token")"

# Every API call goes through the `api` container, because nothing publishes a
# host port. `docker compose exec` on a distroless image has no shell, so the
# calls run from the server image, which has Node.
api() {
  local method="$1" path="$2" body="${3:-}"
  "${COMPOSE[@]}" exec -T \
    -e RP_METHOD="${method}" -e RP_PATH="${path}" -e RP_BODY="${body}" \
    -e RP_TOKEN="${BOOTSTRAP_TOKEN}" \
    api node -e '
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

# The human test client.
#
# It is a **separate credential from `api()` above, and that is the whole point
# of it**. `api()` presents the bootstrap operator token, whose principal
# carries `organisationId: null` and `projectIds: null` — both tenancy terms
# vacuous — so it can reach every project in the deployment and an acceptance
# driven by it would pass against a control plane that had no idea who was
# accepting. `docs/TESTING.md` §10 says a suite covering a route a signed-in
# person reaches MUST drive it as one. This is that client: an account claimed
# from the install token, signed in with a password, presenting the session
# cookie and echoing its CSRF token on every write.
#
# HUMAN_COOKIE and HUMAN_CSRF are set by `human_sign_in` below. No `Origin`
# header is sent: `REVIEWPLANE_ALLOWED_ORIGINS` guards the two body-credential
# routes against another *site*, and a non-browser client sends none.
HUMAN_COOKIE=""
HUMAN_CSRF=""
human() {
  local method="$1" path="$2" body="${3:-}" idempotency="${4:-}"
  "${COMPOSE[@]}" exec -T \
    -e RP_METHOD="${method}" -e RP_PATH="${path}" -e RP_BODY="${body}" \
    -e RP_COOKIE="${HUMAN_COOKIE}" -e RP_CSRF="${HUMAN_CSRF}" \
    -e RP_IDEMPOTENCY="${idempotency}" \
    api node -e '
      const method = process.env.RP_METHOD;
      const body = process.env.RP_BODY;
      const headers = {};
      if (process.env.RP_COOKIE) headers.cookie = process.env.RP_COOKIE;
      if (process.env.RP_CSRF) headers["x-csrf-token"] = process.env.RP_CSRF;
      if (process.env.RP_IDEMPOTENCY) headers["idempotency-key"] = process.env.RP_IDEMPOTENCY;
      if (body) headers["content-type"] = "application/json";
      const response = await fetch(`http://127.0.0.1:8080${process.env.RP_PATH}`, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
      const text = await response.text();
      // The cookies are returned so the caller can capture a new session. The
      // values are opaque here and are never printed: they go into shell
      // variables that only this script reads.
      const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      process.stdout.write(JSON.stringify({ status: response.status, body: text, cookies }));
    '
}

# Extracts one cookie value from a `human()` response, URL-decoded.
#
# The CSRF token is delivered in a readable cookie and echoed in a header; the
# value in the cookie is percent-encoded and the header is not, so a client that
# forwarded it verbatim would be refused with `csrf_token_invalid` on every
# write and would look like a permissions problem.
cookie_value() {
  RP_RESPONSE="$1" RP_NAME="$2" python3 -c '
import json, os, sys
from urllib.parse import unquote

outer = json.loads(os.environ["RP_RESPONSE"])
name = os.environ["RP_NAME"]
for header in outer.get("cookies") or []:
    first = header.split(";", 1)[0]
    if "=" not in first:
        continue
    key, value = first.split("=", 1)
    if key.strip() == name:
        sys.stdout.write(unquote(value))
        sys.exit(0)
sys.exit(1)
'
}

# One scalar from the database: unaligned, no column header, no trailing
# newline. Used for the two bounded waits below, where the condition is a count
# and a call site that had to strip whitespace on every comparison would be one
# forgotten `tr` away from comparing "0\n" with "0" forever.
psql_scalar() {
  "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -c "$1" | tr -d '\r\n'
}

# One row from the database as pipe-separated fields, with carriage returns
# stripped. NULL is rendered by the caller's `coalesce`, because psql prints it
# as the empty string and an empty field is indistinguishable from a column that
# happens to hold one.
psql_row() {
  "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c "$1" | tr -d '\r'
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
# A stack left under *this* project name — by REVIEWPLANE_E2E_KEEP_UP=1 with a
# fixed COMPOSE_PROJECT_NAME, or by an interrupted run of the same name — would
# poison this one: step 0 regenerates the database password while the old volume
# still holds the old one. Tearing down first makes the scenario repeatable
# rather than dependent on how the last run ended. With the default per-run
# name this is a no-op, which is the point: concurrent runs do not collide.
"${COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
info "compose project: ${COMPOSE_PROJECT_NAME}"

"${COMPOSE[@]}" build --quiet api browser-worker tunnel-gateway dev-fixture

# The order is forced by two dependencies that only exist at run time.
#
# The tunnel gateway verifies connector identities against the connector CA,
# which the control plane generates at its own first start (ADR-0014), so the
# gateway cannot start until the api role has run once and the CA has been
# exported. The browser worker registers with the control plane as it starts,
# so it cannot come up before the api role either. Bringing everything up at once
# would make both of those a race that usually loses.
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 postgres api \
  || fail "postgres and the control plane did not become healthy"
info "postgres and api are up"

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

# The agent endpoint and the edge gateway in front of it.
#
# The development environment dials the gateway for `/mcp/v1` and nothing else,
# and it verifies the name it dialled against the certificate the gateway
# serves. That certificate comes from Caddy's internal authority, which is a
# third anchor beside the two above, so it is added to the connector's trust
# bundle here — before `dev-fixture` starts, because the bundle is mounted
# read-only and the connector reads it once.
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 mcp gateway \
  || fail "the MCP server and the edge gateway did not start"

# The bounded wait, and what it proves.
#
# Caddy provisions its internal authority as it loads its configuration, so the
# root certificate existing in the volume is the authority having been generated
# — which is the authority that signed the certificate the connector is about to
# verify. Copying it is therefore the condition, not a proxy for it: a copy that
# succeeds is a bundle that can verify this gateway. The gateway's own
# `/healthz` is asserted afterwards because a trusted certificate on a listener
# that is not answering is not a reachable endpoint.
CADDY_ROOT="${COMPOSE_DIR}/tls/edge-ca.pem"
rm -f "${CADDY_ROOT}"
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" cp gateway:/data/caddy/pki/authorities/local/root.crt "${CADDY_ROOT}" >/dev/null 2>&1 \
    && [[ -s "${CADDY_ROOT}" ]]; then
    break
  fi
  sleep 1
done
[[ -s "${CADDY_ROOT}" ]] \
  || fail "the edge gateway never wrote its internal authority; the development environment would trust nothing it serves"
cat "${CADDY_ROOT}" >> "${COMPOSE_DIR}/tls/connector-trust.pem"
chmod 644 "${COMPOSE_DIR}/tls/connector-trust.pem"
info "added the edge gateway's authority to tls/connector-trust.pem"

# The gateway's own liveness route, which answers without reaching an upstream
# so that a failing control plane is diagnosed as a failing control plane. The
# certificate is deliberately **not** verified here and this probe asserts
# nothing about trust: the `api` container has no copy of the authority, and the
# property that matters — that the development environment's bundle verifies
# this gateway — is asserted at step 9, where the bridge either completes a TLS
# handshake against it or the scenario fails.
EDGE_READY=0
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T -e NODE_TLS_REJECT_UNAUTHORIZED=0 api node -e '
      fetch("https://gateway:8443/healthz")
        .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
    ' 2>/dev/null; then
    EDGE_READY=1
    break
  fi
  sleep 1
done
[[ "${EDGE_READY}" -eq 1 ]] || fail "the edge gateway did not answer /healthz"
info "the edge gateway is serving ${REVIEWPLANE_GATEWAY_DOMAIN}:8443"

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
  if "${COMPOSE[@]}" exec -T api node -e '
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

# Only the edge gateway may be published to the host
# (`docs/DEPLOYMENT.md` §20), and nothing in the development environment may be
# published at all — Stage 0 exit criterion 5, stated as a property of the
# deployment rather than of one container.
#
# The gateway is named rather than the check relaxed: it is the one component
# whose job is to be reachable, and every other service publishing nothing is
# what makes that a boundary. An earlier revision asserted that *no* container
# published anything, which passed only because the scenario never started the
# gateway; the moment it did, the assertion would have failed on the one
# publication the design requires.
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
    if record.get("Service") == "gateway":
        continue
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
  fail "a container other than the edge gateway published a host port: ${PUBLISHED}"
fi
info "only the edge gateway publishes a host port"

# The enrolment token comes first, and the project is created in the
# organisation it names.
#
# Enrolment refuses a token minted for any organisation but the one this
# deployment is configured with (`CONNECTOR_PROTOCOL.md` §4.1 as Stage 0
# implements it, `apps/server/src/modules/connectors/enrolment.ts`), so a
# scenario that created its own organisation and then enrolled a connector into
# it could never have had both in the same place. That did not matter while
# publication wrote whatever `connector_id` it was given; it does now, because
# the control plane resolves the connector inside the caller's organisation, and
# a connector in one organisation publishing into another's project is exactly
# the cross-organisation shape that is refused.
#
# No environment_labels: a token that requires them is refused unless the
# enrolling environment declares the same set, and the fixture describes itself
# through its configuration file rather than through flags in an entry point.
TOKEN_RESPONSE="$(api POST /api/v1/connectors/enrolment-tokens "{\"max_uses\":1,\"expires_in_seconds\":600}")"
ORGANISATION_ID="$(field "${TOKEN_RESPONSE}" 'data["organisation_id"]')" || fail "the enrolment token named no organisation"

# The project is created with the identifier `connector-config.yaml` declares,
# and that is the point of doing it here rather than through the API, which
# generates one.
#
# The fixture connector is configured with `project: prj_fixture` and
# `workspaces: [{id: wsp_fixture}]`, and it validates the workspace association
# itself (`docs/CONNECTOR_PROTOCOL.md` §11).
#
# **No workspace row is written here.** One used to be, with a placeholder head
# commit and a path hash of sixty-four zeroes, because the fixture was a served
# directory rather than a Git checkout and the connector was never going to
# report one. That row was the shape an observation produces without any
# observation having happened, in a scenario that is release-blocking. The
# fixture is a real checkout now (`examples/dev-fixture/Dockerfile`), and step
# 3a below waits for the connector's own report and asserts it against that
# checkout's actual HEAD. Remove the connector and the scenario fails there,
# which is the property the insert destroyed.
"${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -q -c \
  "insert into projects (id, organisation_id, name, slug)
   values ('${PROJECT_ID}', '${ORGANISATION_ID}', 'Fixture', '${PROJECT_SLUG}')
   on conflict (id) do nothing" >/dev/null \
  || fail "could not create the project"
info "organisation ${ORGANISATION_ID}, project ${PROJECT_ID}"
ENROLMENT_TOKEN="$(field "${TOKEN_RESPONSE}" 'data["enrolment_token"]')" || fail "could not issue an enrolment token"
printf '%s' "${ENROLMENT_TOKEN}" > "${COMPOSE_DIR}/secrets/enrolment_token"
# 0644 for the reason generate-secrets.sh records: a plain-Compose file secret
# keeps its host permissions and the service user is uid 10001.
chmod 644 "${COMPOSE_DIR}/secrets/enrolment_token"
info "issued a single-use enrolment token"

# The connector reads the generated copy, which Compose mounts; `configure`
# makes the same copy for an ordinary installation.
#
# It used to be a `sed` substituting the generated project identifier into the
# configuration, which is why the connector's own §11 checks passed while the
# scenario was otherwise disagreeing with its fixture. The scenario now creates
# the project under the identifier the configuration already names, so there is
# nothing to substitute and a copy is the whole of it.
cp "${COMPOSE_DIR}/connector-config.yaml" "${COMPOSE_DIR}/connector-config.generated.yaml"

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

# ---------------------------------------------------------------------------
step "3a. The connector observes the development machine's checkout (docs/CONNECTOR_PROTOCOL.md §9)"
# ---------------------------------------------------------------------------
# The workspace the connector is configured to serve, read from the
# configuration file the fixture actually mounts rather than restated here. A
# constant typed twice would only assert that this script agrees with itself;
# reading the configuration asserts that the control plane recorded what this
# deployment configured.
CONNECTOR_CONFIG="${COMPOSE_DIR}/connector-config.generated.yaml"
CONFIGURED_WORKSPACE_ID="$(awk '/^workspaces:/ {inside = 1; next}
                                inside && $1 == "-" && $2 == "id:" {print $3; exit}' "${CONNECTOR_CONFIG}")"
CONFIGURED_WORKSPACE_PATH="$(awk '/^workspaces:/ {inside = 1; next}
                                  inside && $1 == "path:" {print $2; exit}' "${CONNECTOR_CONFIG}")"
[[ -n "${CONFIGURED_WORKSPACE_ID}" && -n "${CONFIGURED_WORKSPACE_PATH}" ]] \
  || fail "could not read the connector's configured workspace out of ${CONNECTOR_CONFIG}"

# `docs/DOMAIN_MODEL.md` §9 hashes the checkout's absolute path precisely so the
# path itself never leaves the development machine, and RVP-92 was an Urgent
# defect about disclosing it. The path is therefore used here to derive the
# digest the control plane must have recorded, and is never printed, never
# written to the evidence directory and never read back out of the database —
# only digests are compared, and only digests are kept.
EXPECTED_PATH_HASH="$(RP_PATH="${CONFIGURED_WORKSPACE_PATH}" python3 -c '
import hashlib, os, sys
sys.stdout.write("sha256:" + hashlib.sha256(os.environ["RP_PATH"].encode("utf-8")).hexdigest())
')"
EXPECTED_DISPLAY_PATH="$(basename "${CONFIGURED_WORKSPACE_PATH}")"

# The checkout's own answers, read from inside the development environment with
# the same questions the connector asks it. Taking the head commit from the
# repository rather than from a literal is what makes the comparison below an
# assertion about an observation rather than about two constants agreeing.
fixture_git() {
  "${COMPOSE[@]}" exec -T dev-fixture git -C "${CONFIGURED_WORKSPACE_PATH}" "$@" | tr -d '\r\n'
}
FIXTURE_BRANCH="$(fixture_git rev-parse --abbrev-ref HEAD)" \
  || fail "the fixture workspace is not a Git checkout; the connector reports nothing about a directory that is not one"
FIXTURE_HEAD="$(fixture_git rev-parse HEAD)" \
  || fail "the fixture checkout has no commit on HEAD, which yields no observation"
[[ "${FIXTURE_HEAD}" =~ ^[0-9a-f]{40}$ ]] \
  || fail "the fixture checkout reported '${FIXTURE_HEAD}' as its head commit, which is not an object name"
info "the development machine holds a checkout on ${FIXTURE_BRANCH} at ${FIXTURE_HEAD}"

# The bounded wait, and what it proves.
#
# `workspace.observed` is appended by `insertObserved` in
# `apps/server/src/modules/connectors/workspaces.ts`, in the same transaction as
# the workspace row and only on the connector-report path; nothing else in the
# product emits it. So the event existing means a `workspace.observed` frame
# arrived on the mutually authenticated connector channel, the control plane
# re-derived that this identity may act for this project, and it created the
# record. Every assertion below reads that record. The wait is therefore the
# condition the assertions need and not a proxy for it — the failure mode of
# RVP-82, RVP-85 and this script's own `await_worker_assignment`.
#
# The bound: the connector observes its workspaces once before its first dial
# and reports the whole set as soon as §17 reconciliation completes on the
# established channel, then re-observes every `git_context.interval`, which is
# 5s here. 120s covers enrolment, the handshake, reconciliation and a first
# report many times over; it is an outer bound rather than an expected duration,
# and the elapsed time is reported so that a regression shows up as a worse
# number before it shows up as a failure.
OBSERVATION_WAIT_SECONDS=0
await_workspace_observation() {
  local deadline=$((SECONDS + 120)) started="${SECONDS}" observed
  while (( SECONDS < deadline )); do
    observed="$(psql_scalar "select count(*) from events
                              where project_id = '${PROJECT_ID}'
                                and type = 'workspace.observed'")"
    if [[ -n "${observed}" && "${observed}" != "0" ]]; then
      OBSERVATION_WAIT_SECONDS=$((SECONDS - started))
      return 0
    fi
    sleep 2
  done
  return 1
}
await_workspace_observation \
  || fail "no workspace.observed event for ${PROJECT_ID} within 120s: no connector reported a checkout, so nothing observed this development machine's workspace"
info "workspace.observed arrived ${OBSERVATION_WAIT_SECONDS}s after the development environment reported ready"

WORKSPACE_ROWS="$(psql_row "select id, source, coalesce(root_path, '<null>'), path_hash, display_path,
                                   branch, head_commit, dirty, coalesce(environment_id, '<null>'),
                                   coalesce(connector_id, '<null>'), coalesce(repository_identity, '<absent>')
                              from workspaces
                             where organisation_id = '${ORGANISATION_ID}'
                               and project_id = '${PROJECT_ID}'")"
[[ "$(grep -c . <<< "${WORKSPACE_ROWS}")" == "1" ]] \
  || fail "expected exactly one workspace in ${PROJECT_ID}, got: ${WORKSPACE_ROWS}"
IFS='|' read -r W_ID W_SOURCE W_ROOT_PATH W_PATH_HASH W_DISPLAY W_BRANCH W_HEAD W_DIRTY \
  W_ENVIRONMENT W_CONNECTOR W_REPOSITORY <<< "${WORKSPACE_ROWS}"

# The row was produced by an observation and not by anything else.
# `0080_workspace_git_context.sql` keeps `connector_report` and
# `administrative_registration` apart precisely so a reader can tell which
# happened, and the scenario used to write the second while claiming the first.
[[ "${W_SOURCE}" == "connector_report" ]] \
  || fail "the workspace record is ${W_SOURCE}, not connector_report: nothing observed it"
[[ "${W_ENVIRONMENT}" != "<null>" ]] \
  || fail "the workspace record belongs to no environment, so no connector reported it"
[[ "${W_CONNECTOR}" == "${CONNECTOR_ID}" ]] \
  || fail "the workspace record names connector ${W_CONNECTOR}, not the enrolled ${CONNECTOR_ID}"

# The identifier is the connector's own, because a publication names it (§11)
# and step 4 is about to.
[[ "${W_ID}" == "${CONFIGURED_WORKSPACE_ID}" ]] \
  || fail "the observed workspace is ${W_ID}, not the configured ${CONFIGURED_WORKSPACE_ID}"

# The privacy properties of `docs/DOMAIN_MODEL.md` §9, asserted rather than
# assumed. A connector-reported workspace stores no filesystem path at all; the
# digest identifies the checkout and the display label is the directory's own
# name, which the column constraint additionally refuses to let hold a
# separator.
[[ "${W_ROOT_PATH}" == "<null>" ]] \
  || fail "the observed workspace stores a root path, which a connector-reported workspace must never do"
[[ "${W_PATH_HASH}" == "${EXPECTED_PATH_HASH}" ]] \
  || fail "the recorded path hash is not the digest of the configured checkout path"
[[ "${W_DISPLAY}" == "${EXPECTED_DISPLAY_PATH}" ]] \
  || fail "the recorded display path is ${W_DISPLAY}, not the checkout directory's own name"

# The Git context, against what the checkout itself says.
[[ "${W_BRANCH}" == "${FIXTURE_BRANCH}" ]] \
  || fail "the recorded branch is ${W_BRANCH}, but the checkout is on ${FIXTURE_BRANCH}"
[[ "${W_HEAD}" == "${FIXTURE_HEAD}" ]] \
  || fail "the recorded head commit is ${W_HEAD}, but the checkout's HEAD is ${FIXTURE_HEAD}"
[[ "${W_DIRTY}" == "f" ]] \
  || fail "the observed checkout is dirty, which the fixture's committed tree should not be"
# The fixture's checkout has no remote, so §9's "an absent value is reported as
# absent rather than guessed at" is the path being exercised here.
[[ "${W_REPOSITORY}" == "<absent>" ]] \
  || fail "a repository identity was recorded for a checkout with no remote: ${W_REPOSITORY}"
WORKSPACE_ID="${W_ID}"
info "workspace ${WORKSPACE_ID} was reported by ${CONNECTOR_ID}: ${W_BRANCH} at ${W_HEAD}, clean, no path stored"

# The same record through the product's own surface, which is where a human
# sees it (`docs/API.md` §9). It is read as well as the row because the two can
# disagree: the view is what decides whether an operator can see the checkout at
# all, and it deliberately carries no `root_path` — a property worth asserting
# in the response rather than only in the column.
ENVIRONMENTS_RESPONSE="$(api GET "/api/v1/projects/${PROJECT_ID}/environments")"
echo "${ENVIRONMENTS_RESPONSE}" > "${EVIDENCE}/environments.json"
[[ "$(field "${ENVIRONMENTS_RESPONSE}" 'len(data)')" == "1" ]] \
  || fail "the project view reports no single environment for the development machine"
[[ "$(field "${ENVIRONMENTS_RESPONSE}" 'len(data[0]["workspaces"])')" == "1" ]] \
  || fail "the environment view carries no workspace"
[[ "$(field "${ENVIRONMENTS_RESPONSE}" 'data[0]["workspaces"][0]["head_commit"]')" == "${FIXTURE_HEAD}" ]] \
  || fail "the environment view reports a different head commit from the checkout"
[[ "$(field "${ENVIRONMENTS_RESPONSE}" 'data[0]["workspaces"][0]["source"]')" == "connector_report" ]] \
  || fail "the environment view does not report the workspace as connector-reported"
[[ "$(field "${ENVIRONMENTS_RESPONSE}" '"root_path" in data[0]["workspaces"][0]')" == "False" ]] \
  || fail "the environment view exposes a root path for a connector-reported workspace"
info "the environment view carries the workspace, with no filesystem path in it"

# ---------------------------------------------------------------------------
step "3b. Move the checkout's HEAD and prove workspace.head_changed"
# ---------------------------------------------------------------------------
# An observation that never changes proves half of §9. The other half is that a
# change on the development machine reaches the control plane as
# `workspace.head_changed` carrying both sides of the move, which is what
# `docs/DOMAIN_MODEL.md` §24 will read when staleness is computed.
#
# The commit is empty on purpose. The working tree here is the application this
# scenario is about to serve, screenshot and drive through a WebSocket, and
# editing it mid-run would change the thing under test for a reason unrelated to
# this assertion. What §9 reports is the branch, the head commit and the dirty
# flag; a new branch carrying a new commit moves two of the three without
# touching a byte the browser will render.
#
# Both git commands run in one `exec`, so the window in which the connector
# could observe the branch switch without the commit is milliseconds rather than
# a round trip. The assertions below do not depend on that being closed — see
# the two events they read.
HEAD_CHANGE_BRANCH="e2e/head-change"
"${COMPOSE[@]}" exec -T dev-fixture sh -c "
  set -e
  git -C ${CONFIGURED_WORKSPACE_PATH} switch --quiet -c ${HEAD_CHANGE_BRANCH}
  git -C ${CONFIGURED_WORKSPACE_PATH} commit --quiet --allow-empty \
    -m 'e2e: move HEAD so the connector reports a change'
" || fail "could not move the fixture checkout onto a new branch and commit"
CHANGED_BRANCH="$(fixture_git rev-parse --abbrev-ref HEAD)"
CHANGED_HEAD="$(fixture_git rev-parse HEAD)"
[[ "${CHANGED_BRANCH}" == "${HEAD_CHANGE_BRANCH}" ]] \
  || fail "the checkout is on ${CHANGED_BRANCH}, not ${HEAD_CHANGE_BRANCH}"
[[ "${CHANGED_HEAD}" != "${FIXTURE_HEAD}" ]] || fail "the commit did not move HEAD"
info "the development machine moved to ${CHANGED_BRANCH} at ${CHANGED_HEAD}"

# The bounded wait, and what it proves.
#
# `workspace.head_changed` is appended by `updateObserved` only when the branch,
# head commit or dirty state a connector reports differs from the record it is
# updating, and it is written in the same transaction as that update. The poll
# matches on the *new* head commit — the object name `git rev-parse` just read
# inside the development environment — rather than on the event type, so an
# earlier transition cannot satisfy it and the record it describes already
# carries that commit when the wait returns.
#
# The bound: the connector re-observes every `git_context.interval`, 5s in this
# deployment, and reports a change on the following tick. 90s is eighteen
# intervals, so a failure here is a connector that stopped observing rather than
# one that was merely slow.
HEAD_CHANGE_WAIT_SECONDS=0
await_head_change() {
  local deadline=$((SECONDS + 90)) started="${SECONDS}" seen
  while (( SECONDS < deadline )); do
    seen="$(psql_scalar "select count(*) from events
                          where project_id = '${PROJECT_ID}'
                            and type = 'workspace.head_changed'
                            and payload ->> 'head_commit' = '${CHANGED_HEAD}'")"
    if [[ -n "${seen}" && "${seen}" != "0" ]]; then
      HEAD_CHANGE_WAIT_SECONDS=$((SECONDS - started))
      return 0
    fi
    sleep 2
  done
  return 1
}
await_head_change \
  || fail "no workspace.head_changed carrying ${CHANGED_HEAD} within 90s; git_context.interval is 5s, so the connector stopped observing rather than being slow"
info "workspace.head_changed arrived ${HEAD_CHANGE_WAIT_SECONDS}s after the commit"

# Both sides of the move, read from two events rather than one.
#
# The *first* head_changed for this project is the one whose previous state is
# the state step 3a asserted, whether or not the connector happened to observe
# the branch switch and the commit separately. The one carrying the new commit
# is the one whose current state is what the checkout now holds. Reading them
# apart is what makes the assertion independent of that timing rather than
# occasionally wrong about it.
FIRST_CHANGE="$(psql_row "select payload ->> 'workspace_id', payload ->> 'previous_branch',
                                 payload ->> 'previous_head_commit'
                            from events
                           where project_id = '${PROJECT_ID}' and type = 'workspace.head_changed'
                           order by sequence asc limit 1")"
IFS='|' read -r F_WORKSPACE F_PREVIOUS_BRANCH F_PREVIOUS_HEAD <<< "${FIRST_CHANGE}"
[[ "${F_WORKSPACE}" == "${WORKSPACE_ID}" ]] \
  || fail "the first head change names workspace ${F_WORKSPACE}, not ${WORKSPACE_ID}"
[[ "${F_PREVIOUS_BRANCH}" == "${FIXTURE_BRANCH}" ]] \
  || fail "the first head change reports a previous branch of ${F_PREVIOUS_BRANCH}, not ${FIXTURE_BRANCH}"
[[ "${F_PREVIOUS_HEAD}" == "${FIXTURE_HEAD}" ]] \
  || fail "the first head change reports a previous head commit of ${F_PREVIOUS_HEAD}, not ${FIXTURE_HEAD}"

LAST_CHANGE="$(psql_row "select payload ->> 'workspace_id', payload ->> 'branch', payload ->> 'head_commit'
                           from events
                          where project_id = '${PROJECT_ID}' and type = 'workspace.head_changed'
                            and payload ->> 'head_commit' = '${CHANGED_HEAD}'
                          order by sequence desc limit 1")"
IFS='|' read -r L_WORKSPACE L_BRANCH L_HEAD <<< "${LAST_CHANGE}"
[[ "${L_WORKSPACE}" == "${WORKSPACE_ID}" ]] \
  || fail "the head change names workspace ${L_WORKSPACE}, not ${WORKSPACE_ID}"
[[ "${L_BRANCH}" == "${CHANGED_BRANCH}" ]] \
  || fail "the head change reports branch ${L_BRANCH}, not ${CHANGED_BRANCH}"
[[ "${L_HEAD}" == "${CHANGED_HEAD}" ]] \
  || fail "the head change reports head commit ${L_HEAD}, not ${CHANGED_HEAD}"

# The record moved in place. A second row would mean the control plane had
# treated the moved checkout as a different one, which is the identity question
# `(project_id, environment_id, path_hash)` exists to settle.
MOVED_ROWS="$(psql_row "select id, branch, head_commit, path_hash
                          from workspaces
                         where organisation_id = '${ORGANISATION_ID}'
                           and project_id = '${PROJECT_ID}'")"
[[ "$(grep -c . <<< "${MOVED_ROWS}")" == "1" ]] \
  || fail "the head change created a second workspace record: ${MOVED_ROWS}"
IFS='|' read -r M_ID M_BRANCH M_HEAD M_PATH_HASH <<< "${MOVED_ROWS}"
[[ "${M_ID}" == "${WORKSPACE_ID}" ]] || fail "the workspace identifier changed to ${M_ID}"
[[ "${M_BRANCH}" == "${CHANGED_BRANCH}" ]] || fail "the record is still on ${M_BRANCH}"
[[ "${M_HEAD}" == "${CHANGED_HEAD}" ]] || fail "the record still holds ${M_HEAD}"
[[ "${M_PATH_HASH}" == "${EXPECTED_PATH_HASH}" ]] || fail "the record's path hash changed with the branch"
info "the record moved in place: one workspace, now ${M_BRANCH} at ${M_HEAD}"

# The evidence carries digests and object names and no filesystem path, for the
# reason `docs/DOMAIN_MODEL.md` §9 gives: the path is what is deliberately not
# recorded, and an artefact attached to a build is the last place to reintroduce
# it.
{
  printf 'Workspace observation and head change (docs/CONNECTOR_PROTOCOL.md section 9)\n'
  printf '===========================================================================\n\n'
  printf 'Recorded by deploy/compose/e2e/run.sh on %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'What produced the record\n'
  printf -- '------------------------\n'
  printf '  source                 %s\n' "${W_SOURCE}"
  printf '  connector              %s\n' "${W_CONNECTOR}"
  printf '  environment            %s\n' "${W_ENVIRONMENT}"
  printf '  workspace              %s\n' "${WORKSPACE_ID}"
  printf '  workspace.observed     after %ss\n\n' "${OBSERVATION_WAIT_SECONDS}"
  printf 'What the connector reported about the checkout\n'
  printf -- '---------------------------------------------\n'
  printf '  path hash              %s\n' "${W_PATH_HASH}"
  printf '  display path           %s\n' "${W_DISPLAY}"
  printf '  repository identity    %s\n' "${W_REPOSITORY}"
  printf '  branch                 %s\n' "${W_BRANCH}"
  printf '  head commit            %s\n' "${W_HEAD}"
  printf '  dirty                  %s\n' "${W_DIRTY}"
  printf '  root path stored       none\n\n'
  printf '  The checkout answered git rev-parse HEAD with %s inside the\n' "${FIXTURE_HEAD}"
  printf '  development environment, which is the value above. The absolute path is\n'
  printf '  not recorded here or in the database: only its digest travels, and this\n'
  printf '  file holds the digest for the same reason.\n\n'
  printf 'The move\n'
  printf -- '--------\n'
  printf '  previous               %s at %s\n' "${F_PREVIOUS_BRANCH}" "${F_PREVIOUS_HEAD}"
  printf '  current                %s at %s\n' "${M_BRANCH}" "${M_HEAD}"
  printf '  workspace.head_changed after %ss (git_context.interval is 5s)\n' "${HEAD_CHANGE_WAIT_SECONDS}"
} > "${EVIDENCE}/workspace-observation.txt"
info "wrote the workspace observation evidence"

# A worker serves only the projects an assignment names, and there is no
# wildcard: an unassigned worker receives no sessions (docs/API.md section 11).
WORKER_ID="$(field "$(api GET /api/v1/browser-workers)" 'data[0]["id"]')" || fail "no browser worker registered"
api PUT "/api/v1/browser-workers/${WORKER_ID}/assignments" "{\"project_ids\":[\"${PROJECT_ID}\"]}" >/dev/null \
  || fail "could not assign the worker to the project"
info "assigned browser worker ${WORKER_ID} to ${PROJECT_ID}"

# The worker picks the assignment up from its next heartbeat acknowledgement
# (ADR-0026), so no restart is needed. This used to restart the container,
# because the assignment was delivered once at registration and cached for the
# life of the process — which also meant a *revocation* took effect only at
# restart, and that is an authorisation gap rather than an inconvenience
# (RVP-60).
#
# It is picked up on the *next* heartbeat, though, not on the assignment, and
# that distinction is the whole of this wait. Two copies of the assignment
# exist: `browser_worker_projects`, written by the PUT above, and the worker's
# in-memory set, which converges up to one heartbeat interval later — 15
# seconds by default. In between, the control plane's own check passes and the
# worker refuses the allocation with PROJECT_CONTEXT_MISMATCH, which reads as a
# flat contradiction unless you know there are two copies.
#
# So the wait has to observe the worker's copy, and the only thing that
# observes it is an allocation: the worker's check is reachable by no other
# path. Nothing the control plane exposes — the worker list, the assignment
# response, a reservation — reports anything but the row that was just written.
#
# This used to reserve a session with `allocate:false`, which by design does
# not contact the worker at all. It re-read the row the PUT had just written,
# passed on its first attempt about a second after the assignment, and reported
# that the worker had "picked up its assignment from a heartbeat" without
# having asked the worker anything. Step 5 then lost the race the wait was
# supposed to have removed, on every run where the next heartbeat had not
# happened to land in that second.
#
# Allocating is cheap while the answer is still no: the worker checks its
# assignment before it launches a context, so only the attempt that succeeds
# costs a Chromium start, and that session is ended immediately.
ASSIGNMENT_WAIT_SECONDS=0
await_worker_assignment() {
  local deadline=$((SECONDS + 90)) started="${SECONDS}" probe probe_status probe_id
  while (( SECONDS < deadline )); do
    probe="$(api POST "/api/v1/projects/${PROJECT_ID}/browser-sessions" \
      '{"viewport":{"width":1440,"height":900,"device_scale_factor":1}}' 2>/dev/null || true)"
    probe_status="$(field "${probe}" 'data["status"]' 2>/dev/null || true)"
    if [[ "${probe_status}" == "READY" ]]; then
      # The probe allocated a real context on the worker, which is the
      # assertion. End it so it does not hold capacity for the rest of the run.
      # `control_epoch` is mandatory on a lifecycle change and a new session is
      # at epoch 1; the old probe sent `{}`, which was refused with
      # VALIDATION_FAILED and swallowed, so its sessions were never ended.
      probe_id="$(field "${probe}" 'data["id"]' 2>/dev/null || true)"
      if [[ -n "${probe_id}" ]]; then
        api POST "/api/v1/browser-sessions/${probe_id}/terminate" '{"control_epoch":1}' >/dev/null 2>&1 || true
      fi
      ASSIGNMENT_WAIT_SECONDS=$((SECONDS - started))
      return 0
    fi
    sleep 2
  done
  return 1
}
await_worker_assignment \
  || fail "the browser worker did not accept an allocation for ${PROJECT_ID} within 90s; ADR-0026 bounds that by one heartbeat interval"
info "browser worker accepted an allocation ${ASSIGNMENT_WAIT_SECONDS}s after the assignment, with no restart"

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
PUBLISH_BODY="$(printf '{"connector_id":"%s","workspace_id":"%s","local_host":"127.0.0.1","local_port":4321,"protocol":"http","ttl_seconds":3600,"allowed_browser_session_ids":["%s"]}' "${CONNECTOR_ID}" "${WORKSPACE_ID}" "${SESSION_ID}")"
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
session_command() {
  local session="$1" epoch="$2" payload="$3"
  api POST "/api/v1/browser-sessions/${session}/commands" \
    "{\"control_epoch\":${epoch},\"command\":${payload}}"
}

command() {
  local epoch="$1" payload="$2"
  session_command "${SESSION_ID}" "${epoch}" "${payload}"
}

# Waits for literal text to become visible in a session's page, failing with the
# text it was waiting for rather than with a bare timeout.
#
# Every RVP-14 assertion is expressed this way. The worker has no
# JavaScript-evaluation command by design, so what a page can tell the scenario
# is what it renders; each fixture page therefore renders its own result as one
# literal string, and this waits for it.
wait_for_text() {
  local session="$1" text="$2" timeout="${3:-30000}" what="${4:-${2}}"
  local response ok
  response="$(session_command "${session}" 1 \
    "{\"command\":\"wait\",\"timeout_ms\":${timeout},\"wait\":{\"condition\":\"text_visible\",\"text\":$(json_string "${text}")}}")"
  ok="$(field "${response}" 'data["ok"]')" || fail "${what}: the wait command itself failed"
  [[ "${ok}" == "True" ]] || fail "${what}: never became visible within ${timeout}ms (${response})"
}

# Renders a shell string as a JSON string, so a value with a quote or a
# backslash cannot break out of the command envelope.
json_string() {
  RP_VALUE="$1" python3 -c 'import json, os, sys; sys.stdout.write(json.dumps(os.environ["RP_VALUE"]))'
}

# The current time in whole milliseconds.
#
# `date +%s%3N` is not portable: the field width is honoured by GNU coreutils
# and ignored elsewhere, and a `date` that ignores it appends nine digits of
# nanoseconds instead of three, which turns a subtraction into nonsense rather
# than into an error. python3 is already a hard requirement of this script.
now_ms() {
  python3 -c 'import time; print(int(time.time() * 1000))'
}

# Extracts the accessibility snapshot text from a command response.
snapshot_text() {
  field "$1" 'data.get("snapshot", {}).get("text", "")'
}

# Clicks the element with a given role and accessible name.
#
# A click names a snapshot and a reference from it, never a selector: the
# worker refuses a stale reference rather than clicking whatever now occupies
# that position (`docs/MCP_SPEC.md` §7.4). The click then invalidates the
# snapshot, so this takes a fresh one every time rather than reusing a handle.
click_by_name() {
  local session="$1" role="$2" name="$3" snapshot snapshot_id reference
  snapshot="$(session_command "${session}" 1 '{"command":"snapshot","timeout_ms":30000}')"
  snapshot_id="$(field "${snapshot}" 'data["snapshot"]["snapshot_id"]')" \
    || fail "could not snapshot before clicking ${role} \"${name}\""
  reference="$(RP_SNAPSHOT="$(snapshot_text "${snapshot}")" RP_ROLE="${role}" RP_NAME="${name}" python3 -c '
import os, re, sys

pattern = re.compile(r"- %s \"%s\" \[ref=([A-Za-z0-9_-]+)\]" % (
    re.escape(os.environ["RP_ROLE"]), re.escape(os.environ["RP_NAME"])))
match = pattern.search(os.environ["RP_SNAPSHOT"])
if match is None:
    sys.stderr.write("no %s named %r in the snapshot\n" % (
        os.environ["RP_ROLE"], os.environ["RP_NAME"]))
    sys.exit(1)
sys.stdout.write(match.group(1))
')" || fail "the snapshot carries no ${role} named \"${name}\""
  session_command "${session}" 1 \
    "{\"command\":\"click\",\"timeout_ms\":15000,\"click\":{\"snapshot_id\":\"${snapshot_id}\",\"ref\":\"${reference}\"}}" \
    >/dev/null || fail "could not click the ${role} named \"${name}\""
}

# Takes a screenshot in a session and writes the artefact bytes to
# evidence/<name>.png, failing if the result is too small to be a rendered page.
#
# CAPTURED_ARTEFACT_ID is left holding the identifier, because step 8 annotates
# the screenshot a human was shown rather than one it captured for itself: the
# evidence a human accepts has to be the evidence they were looking at.
CAPTURED_ARTEFACT_ID=""
capture_screenshot() {
  local session="$1" name="$2" response artefact size
  response="$(session_command "${session}" 1 \
    '{"command":"take_screenshot","timeout_ms":30000,"take_screenshot":{"full_page":false,"persist":true,"purpose":"verification"}}')"
  artefact="$(field "${response}" 'data.get("screenshot", {}).get("artefact_id")')" || return 1
  # ADR-0019: no route serves an artefact from its identifier. The bytes are
  # reachable only through a short-lived grant bound to the subject that minted
  # it, so this mints one and redeems it with the same credential. The grant
  # identifier in the URL admits nobody on its own.
  "${COMPOSE[@]}" exec -T -e RP_ID="${artefact}" -e RP_TOKEN="${BOOTSTRAP_TOKEN}" api node -e '
      const authorization = `Bearer ${process.env.RP_TOKEN}`;
      const granted = await fetch(`http://127.0.0.1:8080/api/v1/artefacts/${process.env.RP_ID}/grants`, {
        method: "POST",
        headers: { authorization },
      });
      if (!granted.ok) {
        process.stderr.write(`grant for ${process.env.RP_ID}: ${granted.status}\n`);
        process.exit(1);
      }
      const grant = (await granted.json()).data;
      const response = await fetch(`http://127.0.0.1:8080${grant.url}`, { headers: { authorization } });
      if (!response.ok) { process.stderr.write(`artefact ${process.env.RP_ID}: ${response.status}\n`); process.exit(1); }
      process.stdout.write(Buffer.from(await response.arrayBuffer()).toString("base64"));
    ' | base64 -d > "${EVIDENCE}/${name}.png" || return 1
  size="$(stat -c%s "${EVIDENCE}/${name}.png")"
  [[ "${size}" -gt 1000 ]] || fail "${name}.png is ${size} bytes, which is not a rendered page"
  CAPTURED_ARTEFACT_ID="${artefact}"
  info "captured ${name}.png (${size} bytes, artefact ${artefact})"
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
  capture_screenshot "${SESSION_ID}" "screenshot-${label}-${width}x${height}" \
    || fail "screenshot at ${width}x${height} failed"
  if [[ "${label}" == "mobile" ]]; then
    # The picture step 8's human annotates. It is held here rather than
    # re-captured later because the finding must point at the screenshot the
    # human was shown, and anything captured afterwards is a different render.
    HUMAN_SCREENSHOT_ARTEFACT_ID="${CAPTURED_ARTEFACT_ID}"
    HUMAN_SCREENSHOT_VIEWPORT="{\"width\":${width},\"height\":${height},\"device_scale_factor\":${scale}}"
    HUMAN_SCREENSHOT_FILE="${EVIDENCE}/screenshot-${label}-${width}x${height}.png"
  fi
done
[[ -n "${HUMAN_SCREENSHOT_ARTEFACT_ID:-}" ]] || fail "no screenshot was captured for the human to annotate"

# The event sequence the issue requires.
"${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c \
  "select sequence, type from events where project_id = '${PROJECT_ID}' order by sequence" \
  > "${EVIDENCE}/event-sequence.txt" || fail "could not read the event stream"
for expected in workspace.observed workspace.head_changed \
                published_service.requested published_service.ready \
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

# The gateway log is collected before anything reads it. Grepping a file that
# had not been written yet printed a "No such file or directory" warning in the
# middle of a passing run and reported zero refusals whatever had happened.
"${COMPOSE[@]}" logs --no-log-prefix tunnel-gateway 2>/dev/null > "${EVIDENCE}/tunnel-gateway.log" || true

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

# ---------------------------------------------------------------------------
step "T1. WebSocket, server-sent events and streaming through the route (RVP-14)"
# ---------------------------------------------------------------------------
# `docs/ARCHITECTURE.md` section 7.4 lists these as mandatory tunnel
# capabilities. Each fixture page performs its own exchange in the browser and
# renders the outcome as one literal string in a heading, because the worker has
# no JavaScript-evaluation command and a heading is what the accessibility
# snapshot carries into the evidence.

# Back to the desktop viewport the screenshot loop left as mobile. These pages
# are read for their text rather than photographed, but a responsive layout may
# hide content at 390 wide and a hidden result is not a visible one.
command 1 '{"command":"resize","timeout_ms":15000,"resize":{"viewport":{"width":1440,"height":900,"device_scale_factor":1}}}' >/dev/null \
  || fail "could not restore the desktop viewport"

# A WebSocket: three request/response exchanges and a clean close, in both
# directions, through the gateway, the data channel and the connector.
command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/websocket","wait_until":"load"}}' >/dev/null \
  || fail "could not open the WebSocket fixture page"
wait_for_text "${SESSION_ID}" "ws: echoed=3 code=1000 clean=true" 30000 "the WebSocket echo result"
WS_SNAPSHOT="$(command 1 '{"command":"snapshot","timeout_ms":30000}')"
snapshot_text "${WS_SNAPSHOT}" > "${EVIDENCE}/websocket-echo.txt" \
  || fail "could not capture the WebSocket page snapshot"
info "a WebSocket carried frames both ways and closed cleanly (code 1000)"

# Server-sent events. The page measures its own arrival gaps: a hop that
# buffered would deliver every event at once at close, and the page would say
# `sse: buffered` instead. Timing is the assertion, not the final content.
command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/sse","wait_until":"load"}}' >/dev/null \
  || fail "could not open the server-sent-events fixture page"
wait_for_text "${SESSION_ID}" "sse: incremental" 60000 "the incremental server-sent-events result"
SSE_SNAPSHOT="$(command 1 '{"command":"snapshot","timeout_ms":30000}')"
SSE_TEXT="$(snapshot_text "${SSE_SNAPSHOT}")" || fail "could not capture the SSE page snapshot"
grep -q "sse: buffered" <<< "${SSE_TEXT}" \
  && fail "the event stream arrived as a burst at close; a hop is buffering it"
printf '%s\n' "${SSE_TEXT}" > "${EVIDENCE}/sse-timing.txt"
info "server-sent events arrived incrementally: $(grep -o 'sse gaps ms: [0-9, ]*' <<< "${SSE_TEXT}" | head -1)"

# ---------------------------------------------------------------------------
step "T2. Publish the Vite development server and prove hot module replacement"
# ---------------------------------------------------------------------------
# The claim this step defends: if the update socket fails, the page in central
# Chromium stops updating while still looking live, so a human annotates a stale
# render and an agent verifies against one. A route that carries HTTP but not
# hot reload is worse than one that fails outright, because it fails silently.
VITE_SESSION_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/browser-sessions" "${RESERVE_BODY}")"
VITE_SESSION_ID="$(field "${VITE_SESSION_RESPONSE}" 'data["id"]')" \
  || fail "could not reserve a browser session for the Vite fixture"

VITE_PUBLISH_BODY="$(printf '{"connector_id":"%s","workspace_id":"%s","local_host":"127.0.0.1","local_port":5173,"protocol":"http","ttl_seconds":3600,"allowed_browser_session_ids":["%s"]}' "${CONNECTOR_ID}" "${WORKSPACE_ID}" "${VITE_SESSION_ID}")"
VITE_PUBLISH_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/published-services" "${VITE_PUBLISH_BODY}")"
VITE_SERVICE_ID="$(field "${VITE_PUBLISH_RESPONSE}" 'data["id"]')" || fail "publishing the Vite server failed"
VITE_OBSERVED="$(field "${VITE_PUBLISH_RESPONSE}" 'data["observed_destination"]')"
VITE_ORIGIN="$(field "${VITE_PUBLISH_RESPONSE}" 'data["internal_origin"]')"
[[ "${VITE_OBSERVED}" == "127.0.0.1:5173" ]] || fail "observed_destination is ${VITE_OBSERVED}"
info "published ${VITE_SERVICE_ID} -> ${VITE_OBSERVED}, origin ${VITE_ORIGIN}"
echo "${VITE_PUBLISH_RESPONSE}" > "${EVIDENCE}/published-service-vite.json"

VITE_ALLOCATE="$(api POST "/api/v1/browser-sessions/${VITE_SESSION_ID}/allocate" "{\"published_service_id\":\"${VITE_SERVICE_ID}\"}")"
VITE_STATUS="$(field "${VITE_ALLOCATE}" 'data["status"]')" || fail "allocating the Vite session failed"
[[ "${VITE_STATUS}" == "READY" ]] || fail "the Vite session is ${VITE_STATUS}, not READY"

session_command "${VITE_SESSION_ID}" 1 \
  '{"command":"resize","timeout_ms":15000,"resize":{"viewport":{"width":1440,"height":900,"device_scale_factor":1}}}' >/dev/null \
  || fail "could not size the Vite session"
VITE_NAV="$(session_command "${VITE_SESSION_ID}" 1 '{"command":"navigate","timeout_ms":60000,"navigate":{"url":"/","wait_until":"load"}}')"
VITE_NAV_STATUS="$(field "${VITE_NAV}" 'data.get("navigation", {}).get("http_status")')" \
  || fail "the Vite application did not load through the route"
[[ "${VITE_NAV_STATUS}" == "200" ]] || fail "the Vite application answered ${VITE_NAV_STATUS} through the route"
wait_for_text "${VITE_SESSION_ID}" "HMR marker: ALPHA" 60000 "the Vite marker before the edit"
info "central Chromium loaded the Vite development server through the route"

# Client-side state that a full page reload would destroy. This is the control
# for the whole proof: after the edit, the marker must have changed *and* this
# must have survived. Either alone proves nothing — a full reload also changes
# the marker.
for _ in 1 2 3; do
  click_by_name "${VITE_SESSION_ID}" button count
done
wait_for_text "${VITE_SESSION_ID}" "clicks: 3" 30000 "the click counter before the edit"

HMR_BEFORE_SNAPSHOT="$(session_command "${VITE_SESSION_ID}" 1 '{"command":"snapshot","timeout_ms":30000}')"
snapshot_text "${HMR_BEFORE_SNAPSHOT}" > "${EVIDENCE}/hmr-before.txt" \
  || fail "could not capture the pre-edit snapshot"
capture_screenshot "${VITE_SESSION_ID}" "hmr-before" || fail "could not capture the pre-edit screenshot"

# The edit, made on the development machine while the page is open. `sed -i`
# writes through the one writable path in that container, which is the fixture's
# own source directory.
HMR_STARTED_MS="$(now_ms)"
"${COMPOSE[@]}" exec -T dev-fixture sed -i 's/ALPHA/BRAVO/' /app/vite-app/src/Marker.tsx \
  || fail "could not edit the Vite fixture source inside the development environment"
wait_for_text "${VITE_SESSION_ID}" "HMR marker: BRAVO" 60000 "the edited Vite marker"
HMR_APPLIED_MS="$(now_ms)"
HMR_LATENCY_MS=$(( HMR_APPLIED_MS - HMR_STARTED_MS ))

# The other half: the update was applied, not reloaded. A full page reload would
# have reset the counter to zero, so this wait is short on purpose — it is
# asserting a value that is either already there or gone for good.
wait_for_text "${VITE_SESSION_ID}" "clicks: 3" 5000 "the click counter after the edit (a full reload would have reset it)"

HMR_AFTER_SNAPSHOT="$(session_command "${VITE_SESSION_ID}" 1 '{"command":"snapshot","timeout_ms":30000}')"
snapshot_text "${HMR_AFTER_SNAPSHOT}" > "${EVIDENCE}/hmr-after.txt" \
  || fail "could not capture the post-edit snapshot"
capture_screenshot "${VITE_SESSION_ID}" "hmr-after" || fail "could not capture the post-edit screenshot"
info "hot module replacement applied the edit in ${HMR_LATENCY_MS}ms with client state intact"

# The source is restored, so a repeated run starts from ALPHA whatever happened
# to the volume. It is a fixture, and a scenario that only passed the first time
# would be worse than no scenario.
"${COMPOSE[@]}" exec -T dev-fixture sed -i 's/BRAVO/ALPHA/' /app/vite-app/src/Marker.tsx || true

# ---------------------------------------------------------------------------
step "T3. Record the performance baseline (docs/TESTING.md section 12)"
# ---------------------------------------------------------------------------
# A baseline is a recorded number, not a threshold. `docs/ROADMAP.md` defers
# tuning, so this measures, prints and stores; it does not fail on a figure.
command 1 '{"command":"navigate","timeout_ms":60000,"navigate":{"url":"/throughput","wait_until":"load"}}' >/dev/null \
  || fail "could not open the throughput fixture page"
wait_for_text "${SESSION_ID}" "bulk: done" 60000 "the throughput measurement"
THROUGHPUT_SNAPSHOT="$(command 1 '{"command":"snapshot","timeout_ms":30000}')"
THROUGHPUT_LINE="$(grep -o 'bulk: done[^"]*' <<< "$(snapshot_text "${THROUGHPUT_SNAPSHOT}")" | head -1)"
[[ -n "${THROUGHPUT_LINE}" ]] || fail "the throughput page produced no result"
info "${THROUGHPUT_LINE}"

# The gateway's own counters, which are the other side of the same story: how
# many upgrades it carried and how many bytes went each way.
# The `api` credential, which is the one carrying metrics:read; the `mcp`
# credential withdraws and reads nothing (ADR-0038).
TUNNEL_TOKEN="$(cat "${COMPOSE_DIR}/secrets/tunnel_control_token_api")"
"${COMPOSE[@]}" exec -T -e RP_TOKEN="${TUNNEL_TOKEN}" api node -e '
    const response = await fetch("http://tunnel-gateway:8445/metrics", {
      headers: { authorization: `Bearer ${process.env.RP_TOKEN}` },
    });
    if (!response.ok) { process.stderr.write(`metrics: ${response.status}\n`); process.exit(1); }
    process.stdout.write(await response.text());
  ' > "${EVIDENCE}/gateway-metrics.txt" || fail "could not read the gateway metrics"

UPGRADES_SWITCHED="$(grep -o 'reviewplane_tunnel_upgrades_total{outcome="switched"} [0-9.]*' \
  "${EVIDENCE}/gateway-metrics.txt" | awk '{print $2}' | head -1)"
[[ -n "${UPGRADES_SWITCHED}" && "${UPGRADES_SWITCHED}" != "0" ]] \
  || fail "the gateway recorded no switched upgrades, so nothing was carried as a WebSocket"
info "gateway upgrades switched during the run: ${UPGRADES_SWITCHED}"

{
  printf 'Tunnel performance baseline (docs/TESTING.md section 12)\n'
  printf '========================================================\n\n'
  printf 'Recorded by deploy/compose/e2e/run.sh on %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'Measurements\n'
  printf -- '------------\n'
  printf '  Tunnel throughput, browser fetch through the route: %s\n' "${THROUGHPUT_LINE}"
  printf '  Hot reload, source save to applied update visible:  %sms\n\n' "${HMR_LATENCY_MS}"
  printf 'What the hot-reload figure includes\n'
  printf -- '-----------------------------------\n'
  printf '  It is wall-clock from the edit landing on the development machine to the\n'
  printf '  updated text being visible in central Chromium, which is what a user\n'
  printf '  experiences. It therefore includes the file watcher (polling every 200ms),\n'
  printf '  the bundler, the update WebSocket through the tunnel, the browser applying\n'
  printf '  the module, and the control-plane round trip that observes it. It is not a\n'
  printf '  measurement of the tunnel alone, and it MUST NOT be read as one.\n\n'
  printf 'Configuration under test\n'
  printf -- '------------------------\n'
  printf '  Gateway stream_idle_timeout        60s (default)\n'
  printf '  Gateway upgrade_idle_timeout       15m (default)\n'
  printf '  Gateway stream_max_lifetime        8h  (default, clipped to route expiry)\n'
  printf '  Gateway relay_buffer_bytes         32768 (default, per direction)\n'
  printf '  Flow-control window                262144 bytes per direction (protocol constant)\n'
  printf '  Route TTL requested                3600s\n'
  printf '  Host header mode                   upstream (default)\n'
  printf '  Forwarded header mode              standard (default)\n\n'
  printf 'Machine\n'
  printf -- '-------\n'
  printf '  %s\n' "$(uname -srmo 2>/dev/null || uname -srm)"
  printf '  CPUs: %s\n' "$(nproc 2>/dev/null || echo unknown)"
  printf '  Memory: %s\n' "$(awk '/MemTotal/ {printf "%.1f GiB", $2/1048576}' /proc/meminfo 2>/dev/null || echo unknown)"
  printf '  Docker: %s\n\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  printf 'Gateway counters at the end of the run\n'
  printf -- '--------------------------------------\n'
  grep -E '^reviewplane_tunnel_(upgrades|streams|bytes|requests|denied)' "${EVIDENCE}/gateway-metrics.txt" \
    | sed 's/^/  /'
} > "${EVIDENCE}/performance-baseline.txt"
info "wrote the performance baseline"

# The gateway log is collected before anything reads it. Grepping a file that
# had not been written yet printed a "No such file or directory" warning in the
# middle of a passing run and reported zero refusals whatever had happened.
"${COMPOSE[@]}" logs --no-log-prefix tunnel-gateway 2>/dev/null > "${EVIDENCE}/tunnel-gateway.log" || true

# ---------------------------------------------------------------------------
step "7. A human signs in and creates the named review (step 7)"
# ---------------------------------------------------------------------------
# The install token is minted by the operator command line, exactly as
# `docs/DEPLOYMENT.md` §11 tells an administrator to. It is single-use and its
# digest is all the control plane keeps, so it is read once here and never
# written to the evidence directory.
INSTALL_TOKEN="$("${COMPOSE[@]}" exec -T api reviewplane install-token \
  | sed -n 's/^[[:space:]]*\(rpi_[A-Za-z0-9._~-]*\)[[:space:]]*$/\1/p' | head -1)"
[[ -n "${INSTALL_TOKEN}" ]] || fail "reviewplane install-token printed no token"
info "minted a single-use installation token"

CLAIM_BODY="$(RP_TOKEN="${INSTALL_TOKEN}" RP_EMAIL="${HUMAN_EMAIL}" RP_PASSWORD="${HUMAN_PASSWORD}" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "token": os.environ["RP_TOKEN"],
    "email": os.environ["RP_EMAIL"],
    "password": os.environ["RP_PASSWORD"],
}))')"
CLAIM_RESPONSE="$(human POST /api/v1/auth/bootstrap "${CLAIM_BODY}")"
field "${CLAIM_RESPONSE}" 'data["user"]["id"]' >/dev/null \
  || fail "claiming the installation failed"

# Signing in rather than reusing the session the claim issued. Both are real,
# and the sign-in is the credential a person actually holds; it also exercises
# the rotation that `docs/SECURITY.md` §6.1 requires on a privilege change.
SIGN_IN_BODY="$(RP_EMAIL="${HUMAN_EMAIL}" RP_PASSWORD="${HUMAN_PASSWORD}" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({"email": os.environ["RP_EMAIL"], "password": os.environ["RP_PASSWORD"]}))')"
SIGN_IN_RESPONSE="$(human POST /api/v1/auth/sessions "${SIGN_IN_BODY}")"
HUMAN_USER_ID="$(field "${SIGN_IN_RESPONSE}" 'data["user"]["id"]')" || fail "sign-in failed"
HUMAN_ORGANISATION_ID="$(field "${SIGN_IN_RESPONSE}" 'data["user"]["organisation_id"]')"
VIEWER_COOKIE="$(cookie_value "${SIGN_IN_RESPONSE}" reviewplane_viewer)" \
  || fail "sign-in issued no session cookie"
HUMAN_CSRF="$(cookie_value "${SIGN_IN_RESPONSE}" reviewplane_csrf)" \
  || fail "sign-in issued no CSRF token"
HUMAN_COOKIE="reviewplane_viewer=${VIEWER_COOKIE}"
info "signed in as ${HUMAN_EMAIL} (${HUMAN_USER_ID})"

# The account and the deployment must be in one organisation, or the human can
# see none of the deployment's own projects. That was the state of a fresh
# installation until the connector module stopped inventing `org_default` beside
# migration 0055's seed (RVP-63): every refusal below would have been correct
# and the product loop would still have been impossible to complete.
[[ "${HUMAN_ORGANISATION_ID}" == "${ORGANISATION_ID}" ]] \
  || fail "the human account is in ${HUMAN_ORGANISATION_ID} but the deployment's connectors and projects are in ${ORGANISATION_ID}; a signed-in person can reach none of them (RVP-63)"


PROJECT_VIEW="$(human GET "/api/v1/projects/${PROJECT_ID}")"
[[ "$(field "${PROJECT_VIEW}" 'data["id"]')" == "${PROJECT_ID}" ]] \
  || fail "the signed-in human cannot read ${PROJECT_ID}"
info "the signed-in human can read ${PROJECT_ID}"

# The review is created against the branch and commit the connector observed,
# read from the control plane's own record rather than restated: a review is
# interpreted against the source context it was captured at, and a constant here
# would assert that this script agrees with itself.
REVIEW_BRANCH="$(psql_scalar "select branch from workspaces where id = '${WORKSPACE_ID}'")"
REVIEW_COMMIT="$(psql_scalar "select head_commit from workspaces where id = '${WORKSPACE_ID}'")"
[[ "${REVIEW_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || fail "the workspace records no head commit to capture against"

REVIEW_BODY="$(RP_SLUG="${REVIEW_SLUG}" RP_BRANCH="${REVIEW_BRANCH}" RP_COMMIT="${REVIEW_COMMIT}" \
  RP_WORKSPACE="${WORKSPACE_ID}" RP_SESSION="${SESSION_ID}" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "slug": os.environ["RP_SLUG"],
    "title": "Bugs on homepage",
    "description": "The homepage heading needs to say what it is.",
    "status": "READY",
    "priority": "high",
    "captured_branch": os.environ["RP_BRANCH"],
    "captured_commit": os.environ["RP_COMMIT"],
    "captured_workspace_id": os.environ["RP_WORKSPACE"],
    "source_browser_session_id": os.environ["RP_SESSION"],
}))')"
# The refusal is asserted before the success, because "the human could read the
# project" is only meaningful beside "and the CSRF rule is being applied".
#
# The body is the **same body step 7 is about to succeed with**, so the only
# difference between the refusal and the success is the header. A malformed body
# would not do: Fastify's own JSON parser answers `VALIDATION_FAILED` before any
# hook runs, so the probe would pass whether or not the rule existed. What is
# claimed here is that the rule is applied, not that it is applied before the
# parser — that stronger property is asserted where it is implemented, in
# `apps/server/test/published-services.test.ts`.
#
# The subshell matters: an assignment in front of a *function* call persists in
# bash after the function returns, so `HUMAN_CSRF="" human ...` would clear the
# token for the rest of the run and every later write would fail for a reason
# that had nothing to do with the code under test.
NO_CSRF="$(HUMAN_CSRF="" ; human POST "/api/v1/projects/${PROJECT_ID}/reviews" "${REVIEW_BODY}")"
NO_CSRF_CODE="$(RP_RESPONSE="${NO_CSRF}" python3 -c '
import json, os, sys
outer = json.loads(os.environ["RP_RESPONSE"])
body = json.loads(outer["body"])
sys.stdout.write(str(body.get("error", {}).get("code")))')"
[[ "${NO_CSRF_CODE}" == "AUTHORISATION_DENIED" ]] \
  || fail "a cookie write with no CSRF token was answered ${NO_CSRF_CODE}, not AUTHORISATION_DENIED"
[[ "$(psql_scalar "select count(*) from reviews where project_id = '${PROJECT_ID}'")" == "0" ]] \
  || fail "the CSRF-less write created a review"
info "a cookie write without the CSRF header is refused, and writes nothing"

REVIEW_RESPONSE="$(human POST "/api/v1/projects/${PROJECT_ID}/reviews" "${REVIEW_BODY}" "rvp95-review")"
REVIEW_ID="$(field "${REVIEW_RESPONSE}" 'data["id"]')" || fail "creating the review failed"
[[ "$(field "${REVIEW_RESPONSE}" 'data["slug"]')" == "${REVIEW_SLUG}" ]] \
  || fail "the review was not created under ${REVIEW_SLUG}"
[[ "$(field "${REVIEW_RESPONSE}" 'data["status"]')" == "READY" ]] \
  || fail "the review is not READY"
REVIEW_VERSION="$(field "${REVIEW_RESPONSE}" 'data["version"]')"
echo "${REVIEW_RESPONSE}" > "${EVIDENCE}/review-created.json"
info "created review ${REVIEW_ID} (${REVIEW_SLUG}) at ${REVIEW_BRANCH}@${REVIEW_COMMIT}"

# ---------------------------------------------------------------------------
step "8. The human creates the annotated finding (step 8)"
# ---------------------------------------------------------------------------
# The review exists before the finding because the control plane's own shape
# requires it — a finding is created *into* a review — and because that is the
# order the web application uses when a human presses Save on a named review
# (`apps/web/src/components/CaptureFinding.tsx`). `docs/TESTING.md` §3 is
# written the same way round for the same reason.
#
# The annotation travels in the same request as the finding, as the SPA sends
# it: a finding whose annotation failed to save would be a report of a problem
# with no indication of where it is.
FINDING_BODY="$(RP_ARTEFACT="${HUMAN_SCREENSHOT_ARTEFACT_ID}" RP_VIEWPORT="${HUMAN_SCREENSHOT_VIEWPORT}" \
  RP_URL="${INTERNAL_ORIGIN%/}/" RP_COMMIT="${REVIEW_COMMIT}" python3 -c '
import json, os, sys
artefact = os.environ["RP_ARTEFACT"]
sys.stdout.write(json.dumps({
    "title": "The homepage heading does not name the fixture",
    "description": "The h1 reads \"Loopback dev fixture\" and should say it was resolved.",
    "severity": "high",
    "url": os.environ["RP_URL"],
    "viewport": json.loads(os.environ["RP_VIEWPORT"]),
    "scroll_position": {"x": 0, "y": 0},
    "captured_commit": os.environ["RP_COMMIT"],
    "screenshot_artefact_id": artefact,
    "acceptance_criteria": "The homepage heading names the resolution.",
    "annotations": [
        {
            "artefact_id": artefact,
            "type": "rectangle",
            "geometry": {"x": 0.05, "y": 0.12, "width": 0.6, "height": 0.1},
            "label": "This heading",
            "marker_number": 1,
        },
        {
            "artefact_id": artefact,
            "type": "numbered_marker",
            "geometry": {"x": 0.08, "y": 0.14},
            "label": "1",
            "marker_number": 1,
        },
    ],
}))')"
FINDING_RESPONSE="$(human POST "/api/v1/reviews/${REVIEW_ID}/findings" "${FINDING_BODY}" "rvp95-finding")"
FINDING_ID="$(field "${FINDING_RESPONSE}" 'data["finding"]["id"]')" || fail "creating the finding failed"
[[ "$(field "${FINDING_RESPONSE}" 'data["finding"]["source"]')" == "human" ]] \
  || fail "the finding's source is not human; a human-authored finding is the one an agent may never accept"
[[ "$(field "${FINDING_RESPONSE}" 'data["finding"]["status"]')" == "OPEN" ]] \
  || fail "the new finding is not OPEN"
[[ "$(field "${FINDING_RESPONSE}" 'len(data["annotations"])')" == "2" ]] \
  || fail "the finding did not record both annotations"
# The overlay is geometry against the original, never pixels over it (ADR-0006).
[[ "$(field "${FINDING_RESPONSE}" 'data["annotations"][0]["artefact_id"]')" == "${HUMAN_SCREENSHOT_ARTEFACT_ID}" ]] \
  || fail "the annotation does not point at the screenshot the human was shown"
echo "${FINDING_RESPONSE}" > "${EVIDENCE}/finding-created.json"

# The original's digest, recorded now, so step 15 can assert the bytes a human
# accepts are the bytes they were shown. `declared_sha256` is what the uploader
# claimed and `sha256` is what the control plane measured; they are compared
# because an artefact is only `available` when they agree, and reading both is
# how that constraint is exercised rather than trusted.
ORIGINAL_ROW="$(psql_row "select declared_sha256, sha256, size_bytes, state, kind
                            from artefacts where id = '${HUMAN_SCREENSHOT_ARTEFACT_ID}'")"
IFS='|' read -r ORIG_DECLARED ORIG_SHA ORIG_SIZE ORIG_STATE ORIG_KIND <<< "${ORIGINAL_ROW}"
[[ "${ORIG_STATE}" == "available" ]] || fail "the annotated screenshot is ${ORIG_STATE}, not available"
[[ "${ORIG_SHA}" == "${ORIG_DECLARED}" ]] \
  || fail "the annotated screenshot's measured digest differs from the declared one"
ORIGINAL_FILE_SHA="$(python3 -c '
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${HUMAN_SCREENSHOT_FILE}")"
[[ "${ORIGINAL_FILE_SHA}" == "${ORIG_SHA}" ]] \
  || fail "the screenshot bytes read back do not digest to what the artefact record holds"
info "finding ${FINDING_ID} with two annotations on artefact ${HUMAN_SCREENSHOT_ARTEFACT_ID} (sha256 ${ORIG_SHA})"

# ---------------------------------------------------------------------------
step "9 to 12. The agent retrieves, resolves and verifies over the local MCP bridge"
# ---------------------------------------------------------------------------
# The agent fixture runs inside the development environment and speaks MCP as a
# real client over `reviewplane-connector mcp`, so the ADR-0023 credential
# exchange and the workspace-to-project resolution are exercised rather than
# bypassed. `deploy/compose/e2e/agent-fixture.mjs` is the client.
#
# One thing it cannot do over that bridge: capture a screenshot. A bridge
# credential carries the workflow capabilities and **no** browser capability
# (`BRIDGE_CAPABILITIES` in `apps/server/src/modules/connectors/agent-
# credentials.ts`, `docs/SECURITY.md` §6.3), while
# `finding_submit_verification` requires at least one screenshot artefact. So
# step 11 opens a second MCP session at the same `/mcp/v1` endpoint with an
# administrator-issued agent credential, which is the shipped way an agent
# obtains browser authority. That is a real gap in the local-bridge path and is
# recorded here rather than papered over.
BROWSER_CREDENTIAL_BODY="$(printf '{"project_ids":["%s"],"capabilities":["project:read","service:publish","browser:control","browser:capture"],"ttl_seconds":3600,"label":"rvp95-agent-browser"}' "${PROJECT_ID}")"
BROWSER_CREDENTIAL_RESPONSE="$(api POST "/api/v1/organisations/${ORGANISATION_ID}/agent-credentials" "${BROWSER_CREDENTIAL_BODY}")"
AGENT_BROWSER_TOKEN="$(field "${BROWSER_CREDENTIAL_RESPONSE}" 'data["token"]')" \
  || fail "could not issue the agent's browser credential"

# Streamed in through a process rather than `docker compose cp`. The daemon
# refuses a copy into a container whose root filesystem is read-only even when
# the destination is a tmpfs, and the development environment's root filesystem
# is read-only for the `docs/SECURITY.md` §10 reason and is not relaxed for a
# fixture. `/tmp` is writable from inside, so a shell inside writes it.
"${COMPOSE[@]}" exec -T dev-fixture sh -c 'cat > /tmp/agent-fixture.mjs' \
  < "${E2E_DIR}/agent-fixture.mjs" \
  || fail "could not place the agent fixture in the development environment"

# The fixture is started before the assignment exists, because that is the
# order the product works in: an agent session has to exist for a review to be
# assigned to it, and nothing is pushed to an agent — it polls its inbox.
AGENT_REPORT="${EVIDENCE}/agent-report.json"
AGENT_LOG="${EVIDENCE}/agent-fixture.log"
"${COMPOSE[@]}" exec -T --workdir /opt/reviewplane/dev-fixture \
  -e RP_REVIEW_SLUG="${REVIEW_SLUG}" \
  -e RP_WORKSPACE_ID="${WORKSPACE_ID}" \
  -e RP_CHECKOUT="${CONFIGURED_WORKSPACE_PATH}" \
  -e RP_MCP_URL="https://${REVIEWPLANE_GATEWAY_DOMAIN}:8443/mcp/v1" \
  -e RP_BROWSER_TOKEN="${AGENT_BROWSER_TOKEN}" \
  -e RP_PROJECT_HINT="${PROJECT_SLUG}" \
  -e NODE_EXTRA_CA_CERTS=/etc/reviewplane/tls/connector-trust.pem \
  dev-fixture node /tmp/agent-fixture.mjs > "${AGENT_REPORT}" 2> "${AGENT_LOG}" &
AGENT_PID=$!

# The bounded wait, and what it proves.
#
# A row in `agent_sessions` for this project is written by the MCP server when a
# credential opens a session, and by nothing else. So the row existing means the
# bridge completed its credential exchange, reached `/mcp/v1` over TLS the
# development environment could verify, and initialised an MCP session — which
# is exactly what the assignment below needs, because a review is assigned to an
# agent session identifier. Waiting on the process, or on a file, would be a
# proxy; this is the thing.
AGENT_SESSION_ID=""
AGENT_SESSION_DEADLINE=$((SECONDS + 180))
while (( SECONDS < AGENT_SESSION_DEADLINE )); do
  AGENT_SESSION_ID="$(psql_scalar "select id from agent_sessions
                                    where project_id = '${PROJECT_ID}'
                                    order by created_at asc limit 1")"
  [[ -n "${AGENT_SESSION_ID}" ]] && break
  if ! kill -0 "${AGENT_PID}" 2>/dev/null; then
    printf '\n--- agent fixture log ---\n' >&2
    cat "${AGENT_LOG}" >&2 || true
    fail "the agent fixture exited before it opened an MCP session"
  fi
  sleep 2
done
[[ -n "${AGENT_SESSION_ID}" ]] \
  || fail "no agent session appeared for ${PROJECT_ID} within 180s; the local MCP bridge never reached the agent endpoint"
info "the agent opened MCP session ${AGENT_SESSION_ID} over the local bridge"

# The human directs the work. Assignment and claiming are different facts
# (`docs/API.md` §12), and this is the first of them.
ASSIGN_BODY="$(printf '{"expected_version":%s,"assigned_agent_session_id":"%s","reason":"Homepage heading"}' \
  "${REVIEW_VERSION}" "${AGENT_SESSION_ID}")"
ASSIGN_RESPONSE="$(human POST "/api/v1/reviews/${REVIEW_ID}/assign" "${ASSIGN_BODY}")"
[[ "$(field "${ASSIGN_RESPONSE}" 'data["status"]')" == "ASSIGNED" ]] \
  || fail "assigning the review did not move it to ASSIGNED"
info "the human assigned ${REVIEW_SLUG} to ${AGENT_SESSION_ID}"

if ! wait "${AGENT_PID}"; then
  printf '\n--- agent fixture log ---\n' >&2
  cat "${AGENT_LOG}" >&2 || true
  printf '\n--- agent fixture report ---\n' >&2
  cat "${AGENT_REPORT}" >&2 || true
  fail "the agent fixture did not complete steps 9 to 12"
fi

agent_field() {
  RP_REPORT="$(cat "${AGENT_REPORT}")" RP_EXPRESSION="$1" python3 -c '
import json, os, sys
report = json.loads(os.environ["RP_REPORT"])
value = eval(os.environ["RP_EXPRESSION"], {"report": report})
sys.stdout.write("" if value is None else str(value))
'
}
[[ "$(agent_field 'report["ok"]')" == "True" ]] || fail "the agent fixture reported a failure"
AGENT_VERIFICATION_ID="$(agent_field 'report["verification_id"]')"
AGENT_FIX_COMMIT="$(agent_field 'report["fix_commit"]')"
[[ "$(agent_field 'report["finding_id"]')" == "${FINDING_ID}" ]] \
  || fail "the agent worked a different finding from the one the human raised"
[[ "$(agent_field 'report["finding_screenshot_artefact_id"]')" == "${HUMAN_SCREENSHOT_ARTEFACT_ID}" ]] \
  || fail "the agent was given a different before screenshot from the one the human annotated"
info "the agent resolved ${FINDING_ID} at ${AGENT_FIX_COMMIT}, verification ${AGENT_VERIFICATION_ID}"

# Every final disposition the agent asked for was refused, and the refusals are
# audited. Both halves are asserted: an agent that was refused and left no
# record would answer "did an agent try to accept a human's finding?" with
# silence (`docs/MCP_SPEC.md` §7.7).
DENIED_OK="$(agent_field 'sum(1 for d in report["denials"] if d["ok"] is not True)')"
DENIED_TOTAL="$(agent_field 'len(report["denials"])')"
[[ "${DENIED_OK}" == "${DENIED_TOTAL}" ]] \
  || fail "an agent request for a final disposition succeeded: $(agent_field 'report["denials"]')"
DENIAL_EVENTS="$(psql_scalar "select count(*) from events
                                where project_id = '${PROJECT_ID}'
                                  and type in ('finding.status_change_denied', 'review.status_change_denied')
                                  and actor_type = 'agent_session'")"
(( DENIAL_EVENTS >= DENIED_TOTAL )) \
  || fail "${DENIED_TOTAL} agent disposition attempts were refused but only ${DENIAL_EVENTS} were audited"
info "${DENIED_TOTAL} agent attempts at a final disposition refused and audited"

# The finding is where an agent can leave it and no further.
FINDING_STATUS="$(psql_scalar "select status from findings where id = '${FINDING_ID}'")"
[[ "${FINDING_STATUS}" == "AWAITING_HUMAN_REVIEW" ]] \
  || fail "the finding is ${FINDING_STATUS}, not AWAITING_HUMAN_REVIEW"

# One verification record from the duplicate submission under one key.
SUBMITTED_COUNT="$(psql_scalar "select count(*) from verifications
                                  where finding_id = '${FINDING_ID}' and status = 'submitted'")"
[[ "${SUBMITTED_COUNT}" == "1" ]] \
  || fail "the finding holds ${SUBMITTED_COUNT} submitted verifications; exactly one may be current"
info "one current verification after a duplicate submission under one idempotency key"

# ---------------------------------------------------------------------------
step "13. A human accepts, and an agent credential cannot (step 13)"
# ---------------------------------------------------------------------------
# The negative comes first. An agent credential presented to the human review
# API is refused by token shape, before anything is resolved
# (`docs/SECURITY.md` §6.3), and nothing moves.
AGENT_ACCEPT="$("${COMPOSE[@]}" exec -T \
  -e RP_TOKEN="${AGENT_BROWSER_TOKEN}" -e RP_PATH="/api/v1/findings/${FINDING_ID}/accept" \
  api node -e '
    const response = await fetch(`http://127.0.0.1:8080${process.env.RP_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expected_version: 1 }),
    });
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
  ')"
AGENT_ACCEPT_CODE="$(RP_RESPONSE="${AGENT_ACCEPT}" python3 -c '
import json, os, sys
outer = json.loads(os.environ["RP_RESPONSE"])
sys.stdout.write(str(json.loads(outer["body"]).get("error", {}).get("code")))')"
[[ "${AGENT_ACCEPT_CODE}" == "AUTHORISATION_DENIED" ]] \
  || fail "an agent credential on the human accept route was answered ${AGENT_ACCEPT_CODE}"
[[ "$(psql_scalar "select status from findings where id = '${FINDING_ID}'")" == "AWAITING_HUMAN_REVIEW" ]] \
  || fail "the agent's accept attempt moved the finding"
info "an agent credential is refused on the human accept route and moves nothing"

# The decision names the verification it decides (ADR-0035): the identifier the
# reader was shown, not one fetched at the moment the button was pressed.
FINDING_VIEW="$(human GET "/api/v1/findings/${FINDING_ID}")"
FINDING_VERSION="$(field "${FINDING_VIEW}" 'data["version"]')" || fail "could not read the finding as the human"
CURRENT_VERIFICATION="$(field "$(human GET "/api/v1/findings/${FINDING_ID}/verification")" 'data["id"]')" \
  || fail "the finding carries no current verification for a human to decide"
[[ "${CURRENT_VERIFICATION}" == "${AGENT_VERIFICATION_ID}" ]] \
  || fail "the current verification is ${CURRENT_VERIFICATION}, not the one the agent submitted"

ACCEPT_BODY="$(printf '{"expected_version":%s,"verification_id":"%s","reason":"The heading names the resolution at both viewports."}' \
  "${FINDING_VERSION}" "${CURRENT_VERIFICATION}")"
ACCEPT_RESPONSE="$(human POST "/api/v1/findings/${FINDING_ID}/accept" "${ACCEPT_BODY}")"
[[ "$(field "${ACCEPT_RESPONSE}" 'data["status"]')" == "RESOLVED" ]] \
  || fail "the human accept did not resolve the finding"
echo "${ACCEPT_RESPONSE}" > "${EVIDENCE}/finding-accepted.json"
info "the human accepted ${FINDING_ID} against verification ${CURRENT_VERIFICATION}"

# The review itself. It reached AWAITING_HUMAN_REVIEW from the agent; only a
# human may take it further, and only once every human-authored finding is
# disposed of.
REVIEW_VIEW="$(human GET "/api/v1/reviews/${REVIEW_ID}")"
REVIEW_STATUS="$(field "${REVIEW_VIEW}" 'data["status"]')"
[[ "${REVIEW_STATUS}" == "AWAITING_HUMAN_REVIEW" ]] \
  || fail "the review is ${REVIEW_STATUS}; an agent should have handed it over"
REVIEW_ACCEPT_BODY="$(printf '{"expected_version":%s,"reason":"Accepted with evidence at both viewports."}' \
  "$(field "${REVIEW_VIEW}" 'data["version"]')")"
REVIEW_ACCEPTED="$(human POST "/api/v1/reviews/${REVIEW_ID}/accept" "${REVIEW_ACCEPT_BODY}")"
[[ "$(field "${REVIEW_ACCEPTED}" 'data["status"]')" == "ACCEPTED" ]] \
  || fail "the human accept did not move the review to ACCEPTED"
# Whose authority it was, read from the record rather than inferred from the
# response code.
ACCEPTED_BY="$(psql_scalar "select coalesce(accepted_by_actor_id, '<null>') from reviews where id = '${REVIEW_ID}'")"
[[ "${ACCEPTED_BY}" == "${HUMAN_USER_ID}" ]] \
  || fail "the review records ${ACCEPTED_BY} as its accepting actor, not the signed-in human"
echo "${REVIEW_ACCEPTED}" > "${EVIDENCE}/review-accepted.json"
info "the human accepted ${REVIEW_SLUG}; the record names ${HUMAN_USER_ID}"

# ---------------------------------------------------------------------------
step "14. Export the review as the portable document (step 14)"
# ---------------------------------------------------------------------------
# Through the operator command line an administrator actually runs, in the image
# that ships it, rather than through the API — `reviewplane export-review` is
# what `docs/DEPLOYMENT.md` §11 documents and what a self-hosted operator has.
"${COMPOSE[@]}" exec -T api reviewplane export-review \
  --project "${PROJECT_ID}" --review "${REVIEW_SLUG}" \
  > "${EVIDENCE}/${REVIEW_SLUG}.review.json" \
  || fail "reviewplane export-review failed"

EXPORT_SUMMARY="$(RP_FINDING="${FINDING_ID}" RP_ORIGINAL="${HUMAN_SCREENSHOT_ARTEFACT_ID}" \
  RP_SLUG="${REVIEW_SLUG}" python3 -c '
import json, os, sys

document = json.load(open(sys.argv[1]))
problems = []
if document.get("format") != "reviewplane-review":
    problems.append("format is %r" % document.get("format"))
if document.get("version") != 1:
    problems.append("version is %r" % document.get("version"))
if document.get("privacy_mode") != "metadata_only":
    problems.append("privacy_mode is %r" % document.get("privacy_mode"))
review = document.get("review") or {}
if review.get("slug") != os.environ["RP_SLUG"]:
    problems.append("slug is %r" % review.get("slug"))
if str(review.get("status")).upper() != "ACCEPTED":
    problems.append("status is %r" % review.get("status"))
findings = document.get("findings") or []
if not any(f.get("id") == os.environ["RP_FINDING"] for f in findings):
    problems.append("the accepted finding is absent")
artefacts = {a.get("id"): a for a in document.get("artefacts") or []}
if os.environ["RP_ORIGINAL"] not in artefacts:
    problems.append("the annotated screenshot is not in the manifest")
for identifier in sys.argv[2:]:
    if identifier not in artefacts:
        problems.append("the after screenshot %s is not in the manifest" % identifier)
for identifier, artefact in artefacts.items():
    if not artefact.get("sha256"):
        problems.append("%s carries no sha256" % identifier)
if problems:
    sys.stderr.write("; ".join(problems) + "\n")
    raise SystemExit(1)
sys.stdout.write(json.dumps({
    "findings": len(findings),
    "artefacts": sorted(artefacts),
    "digests": {i: a["sha256"] for i, a in artefacts.items()},
}))
' "${EVIDENCE}/${REVIEW_SLUG}.review.json" $(agent_field '" ".join(a["artefact_id"] for a in report["after_artefacts"])'))" \
  || fail "the exported review does not describe what was accepted"
info "exported ${REVIEW_SLUG}.review.json: ${EXPORT_SUMMARY}"

# ---------------------------------------------------------------------------
step "15. Assert the event sequence and the artefact hashes (step 15)"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c \
  "select sequence, type, actor_type, id from events where project_id = '${PROJECT_ID}' order by sequence" \
  > "${EVIDENCE}/event-sequence.txt" || fail "could not read the event stream"

# The ordered sequence, asserted as a subsequence in the order the shipped
# product produces it.
#
# `review.created` comes before `finding.created` here, and the issue that
# specified this list had them the other way round. The control plane creates a
# finding *into* a review, so the specified order is not reachable; the
# assertion follows the product and this comment records the correction rather
# than quietly reordering a list.
#
# `connector.enrolled` is deliberately not in this list: enrolment happens
# before the connector is associated with a project, so the event belongs to the
# organisation's stream and not to this project's. It is asserted separately
# below, which is also the assertion that the stream key rule holds.
python3 -c '
import sys

expected = sys.argv[2:]
seen = [line.split("|")[1] for line in open(sys.argv[1]) if line.strip()]
position = 0
missing = []
for wanted in expected:
    try:
        position = seen.index(wanted, position) + 1
    except ValueError:
        missing.append(wanted)
if missing:
    sys.stderr.write("not in order after the events before them: %s\n" % ", ".join(missing))
    sys.stderr.write("observed: %s\n" % ", ".join(seen))
    raise SystemExit(1)
' "${EVIDENCE}/event-sequence.txt" \
  workspace.observed published_service.ready browser_session.ready \
  review.created finding.created finding.annotated \
  review.assigned inbox_item.created inbox_item.acknowledged \
  review.claimed finding.claimed \
  finding.verification_submitted finding.verification_accepted finding.resolved review.accepted \
  || fail "the project's event stream does not carry the scenario's events in order"

ENROLLED="$(psql_scalar "select count(*) from events
                           where organisation_id = '${ORGANISATION_ID}' and type = 'connector.enrolled'")"
(( ENROLLED >= 1 )) || fail "no connector.enrolled event was recorded"

# Per-project monotonic sequence, and deduplication by event identifier. Both
# are read off the whole stream rather than sampled: a gap or a repeat is the
# kind of thing that appears once in a thousand runs and never in a spot check.
python3 -c '
import sys

previous = None
identifiers = set()
for line in open(sys.argv[1]):
    if not line.strip():
        continue
    sequence, _type, _actor, identifier = line.rstrip("\n").split("|", 3)
    sequence = int(sequence)
    if previous is not None and sequence <= previous:
        raise SystemExit("sequence %d does not advance past %d" % (sequence, previous))
    previous = sequence
    if identifier in identifiers:
        raise SystemExit("event identifier %s appears twice" % identifier)
    identifiers.add(identifier)
' "${EVIDENCE}/event-sequence.txt" || fail "the project's event sequence is not monotonic, or an identifier repeats"
info "event sequence complete and monotonic: $(wc -l < "${EVIDENCE}/event-sequence.txt") events"

# The artefact inventory: what was recorded at upload against what is read back
# now, for the original and for both after screenshots. The comparison is of the
# bytes the control plane serves, digested here, against the digest in the row —
# not of one stored field against another.
AFTER_ARTEFACT_IDS="$(agent_field '" ".join(a["artefact_id"] for a in report["after_artefacts"])')"
{
  printf 'Artefact inventory (docs/TESTING.md section 3, step 15)\n'
  printf '======================================================\n\n'
  printf '%-28s %-12s %-10s %s\n' "ARTEFACT" "ROLE" "BYTES" "SHA-256 (recorded = read back)"
} > "${EVIDENCE}/artefact-inventory.txt"

verify_artefact() {
  local artefact="$1" role="$2" row recorded size readback
  row="$(psql_row "select sha256, size_bytes, state from artefacts where id = '${artefact}'")"
  IFS='|' read -r recorded size state <<< "${row}"
  [[ "${state}" == "available" ]] || fail "${artefact} is ${state}, not available"
  "${COMPOSE[@]}" exec -T -e RP_ID="${artefact}" -e RP_TOKEN="${BOOTSTRAP_TOKEN}" api node -e '
      const authorization = `Bearer ${process.env.RP_TOKEN}`;
      const granted = await fetch(`http://127.0.0.1:8080/api/v1/artefacts/${process.env.RP_ID}/grants`, {
        method: "POST", headers: { authorization },
      });
      if (!granted.ok) { process.stderr.write(`grant: ${granted.status}\n`); process.exit(1); }
      const grant = (await granted.json()).data;
      const response = await fetch(`http://127.0.0.1:8080${grant.url}`, { headers: { authorization } });
      if (!response.ok) { process.stderr.write(`content: ${response.status}\n`); process.exit(1); }
      process.stdout.write(Buffer.from(await response.arrayBuffer()).toString("base64"));
    ' | base64 -d > "${EVIDENCE}/artefact-${artefact}.bin" \
    || fail "could not read ${artefact} back"
  readback="$(python3 -c '
import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "${EVIDENCE}/artefact-${artefact}.bin")"
  [[ "${readback}" == "${recorded}" ]] \
    || fail "${artefact}: recorded ${recorded}, read back ${readback}"
  printf '%-28s %-12s %-10s %s\n' "${artefact}" "${role}" "${size}" "${recorded}" \
    >> "${EVIDENCE}/artefact-inventory.txt"
  rm -f "${EVIDENCE}/artefact-${artefact}.bin"
}

verify_artefact "${HUMAN_SCREENSHOT_ARTEFACT_ID}" "before"
for artefact in ${AFTER_ARTEFACT_IDS}; do
  verify_artefact "${artefact}" "after"
done

# The original is byte-unchanged since the human annotated it. Originals are
# stored apart from overlays (ADR-0006), so an annotation must not have touched
# the picture; the digest recorded at step 8 is compared with the digest now.
ORIGINAL_NOW="$(psql_scalar "select sha256 from artefacts where id = '${HUMAN_SCREENSHOT_ARTEFACT_ID}'")"
[[ "${ORIGINAL_NOW}" == "${ORIG_SHA}" ]] \
  || fail "the annotated screenshot changed after it was annotated: ${ORIG_SHA} -> ${ORIGINAL_NOW}"
ANNOTATION_ARTEFACTS="$(psql_scalar "select count(distinct artefact_id) from annotations
                                       where finding_id = '${FINDING_ID}'")"
[[ "${ANNOTATION_ARTEFACTS}" == "1" ]] \
  || fail "the finding's annotations name ${ANNOTATION_ARTEFACTS} artefacts; an overlay is geometry against the original, not a second picture"
{
  printf '\nThe original is unchanged: %s\n' "${ORIG_SHA}"
  printf 'Annotations are geometry against it, in the annotations table, and produced no artefact.\n'
  printf 'Redaction: no redaction fixture is exercised by this scenario (Stage 2).\n'
} >> "${EVIDENCE}/artefact-inventory.txt"
info "artefact hashes match end to end; the annotated original is byte-unchanged"

# ---------------------------------------------------------------------------
step "The fifteen-step scenario passed, with the tunnel capabilities T1 to T3"
# ---------------------------------------------------------------------------
info "evidence: ${EVIDENCE}"
ls -1 "${EVIDENCE}" | sed 's/^/     /'
