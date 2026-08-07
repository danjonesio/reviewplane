#!/usr/bin/env bash
#
# The fault-injection matrix of `docs/TESTING.md` section 11, executed against
# the deployed Compose stack.
#
# Section 11 is a table of failures and the behaviour each must produce. Most
# of its rows are owned by suites that can reach the component in question
# directly — `services/connector/internal/protocolsim` for the reconnect rows,
# `apps/server/test/verification-evidence.test.ts` for the evidence rows,
# `apps/web/test/ui/` for the live-view client. What no suite could reach was
# the deployed stack itself: a fault injected into a real container, with real
# process boundaries, real volumes and a real network between the parts. That is
# what this script is for, and it is the reason it runs containers rather than
# doubles.
#
# The cases here are the ones RVP-97 makes release-blocking, in the order they
# run:
#
#   1. API restart during live view
#   2. Database unavailable
#   3. Artefact store unavailable
#   4. Duplicate verification request
#   5. Connector disconnect during navigation
#   6. Worker crash after screenshot upload
#   7. Retention deletion partial failure — NOT APPLICABLE in Stage 1, and
#      asserted to be so rather than omitted
#
# The order is not arbitrary. Cases 1 to 3 break something and put it back, so
# anything may follow them. Cases 5 and 6 leave a component down for good — the
# fixture's connector cannot re-enrol, because its state is on a tmpfs and its
# enrolment token is single-use, and the worker is killed with its restart
# policy removed — so they go last, and in that order: case 5 still needs a live
# worker to attempt a navigation with, and case 6 needs nothing but the control
# plane. A run stops at the first failure, so a case the report lists as neither
# passed nor failed was not reached and is not a pass.
#
# Case 7 is the one worth explaining. A matrix row that is quietly dropped is
# indistinguishable from one that passed, so this script does not drop it: it
# asserts, mechanically, that this build has no retention deletion to fail —
# `job_kind` in the protocol schema names no retention job. When retention
# arrives the assertion fails, and the case has to be written rather than
# remembered. A "not applicable" nothing checks is a comment.
#
# Every failure produces diagnosis before the stack is torn down: the logs of
# every service, a dump of the event store, and an inventory of the artefact
# store and its metadata. A gate whose failures cannot be diagnosed gets
# disabled, and a disabled gate still reads as coverage, which is worse than
# never having had one.
#
# Run it with:  pnpm test:faults
# Evidence lands in deploy/compose/e2e/evidence-faults/.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E_DIR="${COMPOSE_DIR}/e2e"
EVIDENCE="${E2E_DIR}/evidence-faults"
REPORT="${EVIDENCE}/fault-injection-report.md"
SCHEMA_DIR="$(cd "${COMPOSE_DIR}/../.." && pwd)/packages/protocol/schemas"

# A per-run project name, for the reason `run.sh` gives: `compose.yaml` names
# the project `reviewplane`, which is right for a deployment and wrong for a
# test, because two runs on one machine would tear down each other's stack.
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-reviewplane-faults-$$-$(date +%s)}"
export COMPOSE_PROJECT_NAME
COMPOSE=(
  docker compose
  --project-name "${COMPOSE_PROJECT_NAME}"
  --project-directory "${COMPOSE_DIR}"
  -f "${COMPOSE_DIR}/compose.yaml"
  --profile development
)
KEEP_UP="${REVIEWPLANE_FAULTS_KEEP_UP:-0}"

PROJECT_ID="prj_fixture"
PROJECT_SLUG="fixture"

# Bounds this run applies, declared here and printed in the report. A gate that
# bounds its own coverage and does not say so reads as full coverage.
LOG_TAIL_LINES=400
EVENT_DUMP_LIMIT=2000
# `lostAfterSeconds` (90) plus `monitorIntervalSeconds` (5) plus margin, from
# `apps/server/src/modules/browser-sessions/config.ts`. The shipped defaults are
# used deliberately: shortening them would test a configuration no deployment
# runs.
WORKER_LOSS_BOUND_SECONDS=180

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '   \033[33m! %s\033[0m\n' "$*"; }

# Rows of the matrix report, in the order they were decided.
CASE_ROWS=()
CASE_FAILURES=0
CURRENT_CASE="setup"

record_case() {
  local name="$1" verdict="$2" detail="$3"
  CASE_ROWS+=("${name}|${verdict}|${detail}")
  case "${verdict}" in
    pass) info "PASS  ${name}: ${detail}" ;;
    "not applicable") info "N/A   ${name}: ${detail}" ;;
    *) printf '   \033[31mFAIL  %s: %s\033[0m\n' "${name}" "${detail}" >&2 ;;
  esac
}

# Aborts the run. Every assertion goes through this, so there is exactly one
# path from "something was not true" to "the stack is diagnosed and torn down".
fail() {
  record_case "${CURRENT_CASE}" fail "$*"
  CASE_FAILURES=$((CASE_FAILURES + 1))
  printf '\n\033[31mFAILED (%s): %s\033[0m\n' "${CURRENT_CASE}" "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Diagnosis
# ---------------------------------------------------------------------------
#
# Runs on every exit, successful or not. Three artefacts, because three
# different questions get asked of a fault-injection run: what were the
# processes doing, what did the control plane record, and what evidence
# survived.
#
# A green run collects them too, and that is deliberate: the release pipeline
# uploads this directory as the run's evidence, and a bundle that exists only
# when something broke is a bundle nobody can compare a failure against.
diagnose() {
  mkdir -p "${EVIDENCE}/diagnosis"

  printf '\n--- collecting diagnosis into %s ---\n' "${EVIDENCE}/diagnosis" >&2

  # 1. Logs. Bounded, and the bound is printed: an unbounded dump of a stack
  #    that has been restarted several times is megabytes nobody reads.
  for service in api jobs mcp browser-worker tunnel-gateway postgres dev-fixture gateway; do
    "${COMPOSE[@]}" logs --no-log-prefix --tail "${LOG_TAIL_LINES}" "${service}" \
      > "${EVIDENCE}/diagnosis/${service}.log" 2>&1 || true
  done
  printf 'Each log holds the last %s lines of that service.\n' "${LOG_TAIL_LINES}" \
    > "${EVIDENCE}/diagnosis/README.txt"

  # 2. The event dump. Every meaningful state change produces an event
  #    (AGENTS.md), so "what did the control plane think happened" is answered
  #    here and nowhere else. Bounded, with the total printed beside it so a
  #    truncated dump is visibly truncated.
  {
    printf 'total events: '
    "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At \
      -c "select count(*) from events" 2>/dev/null || printf 'unreadable\n'
    printf '\nlast %s events, oldest first:\n\n' "${EVENT_DUMP_LIMIT}"
    "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c "
      select * from (
        select recorded_at, type, actor_type, coalesce(project_id, '-') as project_id,
               coalesce(payload::text, '{}') as payload
          from events order by recorded_at desc, id desc limit ${EVENT_DUMP_LIMIT}
      ) recent order by recorded_at asc" 2>/dev/null || printf 'the event store could not be read\n'
  } > "${EVIDENCE}/diagnosis/events.txt" 2>&1 || true

  # 3. The artefact inventory: the metadata rows and what is actually on the
  #    volume. The two disagreeing is itself a finding — a row marked
  #    `available` with no object behind it is the failure several of the cases
  #    below exist to detect.
  {
    printf 'artefact metadata\n-----------------\n'
    "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c "
      select id, kind, state, content_type, size_bytes, sha256, retention_class, created_at
        from artefacts order by created_at" 2>/dev/null || printf 'unreadable\n'
    printf '\nverifications\n-------------\n'
    "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -F'|' -c "
      select id, finding_id, status, coalesce(superseded_by_verification_id, '-'), submitted_at
        from verifications order by submitted_at" 2>/dev/null || printf 'unreadable\n'
    printf '\nobjects on the artefact volume\n------------------------------\n'
    "${COMPOSE[@]}" exec -T api node -e '
      const { readdirSync, statSync } = require("node:fs");
      const { join } = require("node:path");
      const root = process.env.REVIEWPLANE_ARTEFACT_PATH;
      const walk = (directory, depth) => {
        if (depth > 6) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) walk(path, depth + 1);
          else process.stdout.write(`${path} ${statSync(path).size}\n`);
        }
      };
      try { walk(root, 0); } catch (error) { process.stdout.write(`unreadable: ${error.message}\n`); }
    ' 2>/dev/null || printf 'the artefact volume could not be listed\n'
  } > "${EVIDENCE}/diagnosis/artefact-inventory.txt" 2>&1 || true

  "${COMPOSE[@]}" ps --format json > "${EVIDENCE}/diagnosis/containers.json" 2>&1 || true
}

write_report() {
  local status="$1"
  {
    printf '# Fault-injection matrix (docs/TESTING.md section 11)\n\n'
    printf 'Run by `deploy/compose/e2e/fault-injection.sh` on %s\n\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'Compose project: `%s`\n\n' "${COMPOSE_PROJECT_NAME}"
    printf 'Overall: **%s**\n\n' "${status}"
    printf '| Case | Verdict | Detail |\n|---|---|---|\n'
    local row
    for row in "${CASE_ROWS[@]}"; do
      printf '| %s | %s | %s |\n' "${row%%|*}" \
        "$(printf '%s' "${row}" | cut -d'|' -f2)" \
        "$(printf '%s' "${row}" | cut -d'|' -f3-)"
    done
    printf '\n## What this run bounded\n\n'
    printf 'Stated because a bound nobody declared reads as full coverage.\n\n'
    printf -- '- Service logs are the last %s lines per service, not the whole log.\n' "${LOG_TAIL_LINES}"
    printf -- '- The event dump is the newest %s events; the total is printed beside it.\n' "${EVENT_DUMP_LIMIT}"
    printf -- '- The worker-loss case waits at most %ss, derived from the shipped\n' "${WORKER_LOSS_BOUND_SECONDS}"
    printf '  `lostAfterSeconds` (90) plus `monitorIntervalSeconds` (5) plus margin. The shipped\n'
    printf '  defaults are used rather than shortened ones, so the case measures the deployment\n'
    printf '  an operator runs.\n'
    printf -- '- Cases run in order and the run **stops at the first failure**. A case listed\n'
    printf '  neither pass nor fail in the table above was not reached; it is not a pass.\n'
    printf -- '- The duplicate-verification case drives the **human** API, which carries no\n'
    printf '  idempotency key on that route. What is asserted here is the database-level\n'
    printf '  guarantee — exactly one current verification per finding. The agent path'"'"'s\n'
    printf '  `idempotency_key` is exercised in `apps/mcp-server/test/mcp.test.ts`, not here.\n'
    printf '\n## Rows of section 11 this script does not cover\n\n'
    printf 'They have owners elsewhere and are listed so that nobody reads this report as the\n'
    printf 'whole matrix: the connector reconnect, flapping and desired-state rows are\n'
    printf '`services/connector/internal/protocolsim` and `apps/server/test/connector-reconnect.test.ts`;\n'
    printf 'the artefact upload, idempotency and grant rows are `apps/server/test/artefact-security.test.ts`\n'
    printf 'and `verification-evidence.test.ts`; the WebSocket, stream-limit and idle-window rows\n'
    printf 'are `services/tunnel-gateway`; the `reviewplane status` rows are `pnpm test:install`;\n'
    printf 'the live-view client reconnect is `apps/web/test/ui/`.\n'
  } > "${REPORT}"
  info "wrote ${REPORT}"
}

cleanup() {
  local status=$?
  set +e
  if [[ ${status} -ne 0 ]]; then
    diagnose
    write_report "FAILED"
  fi
  if [[ "${KEEP_UP}" != "1" ]]; then
    "${COMPOSE[@]}" down --volumes --remove-orphans > /dev/null 2>&1
  else
    info "stack left running (REVIEWPLANE_FAULTS_KEEP_UP=1); tear down with:"
    info "  docker compose --project-name ${COMPOSE_PROJECT_NAME} --project-directory ${COMPOSE_DIR} --profile development down -v"
  fi
  exit "${status}"
}
trap cleanup EXIT

for tool in docker openssl python3; do
  command -v "${tool}" > /dev/null 2>&1 || fail "${tool} is required"
done
docker compose version > /dev/null 2>&1 || fail "docker compose v2 is required"

rm -rf "${EVIDENCE}"
mkdir -p "${EVIDENCE}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Every API call runs from inside the `api` container, because nothing
# publishes a host port. `RP_HEADERS` carries any extra headers as JSON.
#
# It is bounded twice, and both bounds matter. `docs/TESTING.md` §2 requires
# every wait in a fixture to be bounded in a way that can actually be reached,
# and an unbounded subprocess in a script that deliberately breaks the thing it
# is calling is the exact shape that rule describes: the run stalls instead of
# failing, and a stalled gate reports nothing at all. The inner `AbortSignal`
# bounds the request; the outer `timeout` bounds everything else, including a
# `docker exec` into a container that has stopped answering.
#
# A call that does not complete answers a status of **0** rather than nothing,
# so that every caller's parsing stays valid and a hang is reported as a
# diagnosable refusal rather than as a crash in the next helper.
API_TIMEOUT_SECONDS=90
api() {
  local method="$1" path="$2" body="${3:-}" headers="${4:-{\}}" out
  if ! out="$(timeout "$((API_TIMEOUT_SECONDS + 30))" "${COMPOSE[@]}" exec -T \
    -e RP_METHOD="${method}" -e RP_PATH="${path}" -e RP_BODY="${body}" \
    -e RP_HEADERS="${headers}" -e RP_TOKEN="${BOOTSTRAP_TOKEN}" \
    -e RP_TIMEOUT_MS="$((API_TIMEOUT_SECONDS * 1000))" \
    api node -e '
      // An async function rather than top-level await. `node -e` decides
      // between CommonJS and modules by detection, and that decision is not
      // stable across the Node builds this repository runs: the same shape of
      // program evaluated fine through `docker compose exec` and failed with
      // "await is only valid in async functions" through `docker compose run`.
      // An async function needs no detection to be right.
      void (async () => {
        const headers = {
          authorization: `Bearer ${process.env.RP_TOKEN}`,
          ...JSON.parse(process.env.RP_HEADERS || "{}"),
        };
        const body = process.env.RP_BODY;
        if (body) headers["content-type"] = "application/json";
        try {
          const response = await fetch(`http://127.0.0.1:8080${process.env.RP_PATH}`, {
            method: process.env.RP_METHOD,
            headers,
            signal: AbortSignal.timeout(Number(process.env.RP_TIMEOUT_MS)),
            ...(body ? { body } : {}),
          });
          const text = await response.text();
          process.stdout.write(JSON.stringify({ status: response.status, body: text }));
        } catch (error) {
          // A transport failure is reported as a status of 0 rather than as a
          // crash, so that a case asserting "the call was refused" can tell a
          // refusal apart from an unreachable server.
          process.stdout.write(JSON.stringify({ status: 0, body: String(error && error.message) }));
        }
      })();
    ')" || [[ -z "${out}" ]]; then
    printf '{"status":0,"body":"the call did not complete within %ss"}' "$((API_TIMEOUT_SECONDS + 30))"
    return 0
  fi
  printf '%s' "${out}"
}

# One field of a successful envelope, failing when the call did not succeed.
field() {
  RP_RESPONSE="$1" RP_EXPRESSION="$2" python3 -c '
import json, os, sys

outer = json.loads(os.environ["RP_RESPONSE"])
if outer["status"] >= 400 or outer["status"] == 0:
    sys.stderr.write("HTTP %d: %s\n" % (outer["status"], outer["body"]))
    sys.exit(1)
body = json.loads(outer["body"])
value = eval(os.environ["RP_EXPRESSION"], {"data": body.get("data"), "body": body})
sys.stdout.write("" if value is None else str(value))
'
}

http_status() {
  RP_RESPONSE="$1" python3 -c 'import json, os, sys; sys.stdout.write(str(json.loads(os.environ["RP_RESPONSE"])["status"]))'
}

http_body() {
  RP_RESPONSE="$1" python3 -c 'import json, os, sys; sys.stdout.write(json.loads(os.environ["RP_RESPONSE"])["body"])'
}

# The stable error code of a refusal, or the empty string when the body is not
# a refusal envelope. Cases assert on this rather than on a status code, because
# "it was refused" and "it was refused for the documented reason" are different
# claims and only the second is what section 11 asks for.
error_code() {
  RP_RESPONSE="$1" python3 -c '
import json, os, sys

outer = json.loads(os.environ["RP_RESPONSE"])
try:
    body = json.loads(outer["body"])
except Exception:
    sys.stdout.write("")
    sys.exit(0)
sys.stdout.write(str((body.get("error") or {}).get("code") or ""))
'
}

psql_scalar() {
  "${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -At -c "$1" | tr -d '\r\n'
}

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

json_string() {
  RP_VALUE="$1" python3 -c 'import json, os, sys; sys.stdout.write(json.dumps(os.environ["RP_VALUE"]))'
}

session_command() {
  local epoch="$1" payload="$2"
  api POST "/api/v1/browser-sessions/${SESSION_ID}/commands" \
    "{\"control_epoch\":${epoch},\"command\":${payload}}"
}

# Captures a screenshot and prints its artefact identifier.
capture_screenshot() {
  local response artefact
  response="$(session_command 1 \
    '{"command":"take_screenshot","timeout_ms":30000,"take_screenshot":{"full_page":false,"persist":true,"purpose":"verification"}}')"
  artefact="$(field "${response}" 'data.get("screenshot", {}).get("artefact_id")')" \
    || fail "a screenshot could not be captured: ${response}"
  [[ -n "${artefact}" ]] || fail "the screenshot response carried no artefact identifier: ${response}"
  printf '%s' "${artefact}"
}

# Waits for `condition` (a shell command) to succeed, up to `bound` seconds.
# Prints the elapsed seconds and returns non-zero when the bound expires.
#
# It deliberately does **not** call `fail` itself. Callers capture its output in
# a command substitution, which runs in a subshell, and a `fail` there would
# exit that subshell: the abort would still happen, through `set -e`, but the
# recorded case row would be written in a shell that is about to disappear and
# the report would lose the reason. So the caller decides, in the shell that
# owns the report.
await() {
  local bound="$1"
  shift
  local started="${SECONDS}"
  while (( SECONDS - started < bound )); do
    if "$@"; then
      printf '%s' "$((SECONDS - started))"
      return 0
    fi
    sleep 2
  done
  return 1
}

# Makes the artefact volume unwritable, or writable again.
#
# Every directory in the tree, not only its root: the availability probe writes
# into `<root>/probe/`, and a root that is unwritable while an existing `probe`
# directory is not would leave the probe succeeding — which would make this case
# pass while the fault it injects had not happened.
#
# It runs as the **service user**, not as root. `compose.yaml` gives the api
# service `cap_drop: [ALL]` and `no-new-privileges`, so `exec --user 0` is a uid
# with no capabilities: it holds neither CAP_FOWNER nor CAP_CHOWN and cannot
# chmod a file it does not own. The service user owns the whole tree, and
# changing the mode of something you own needs no capability at all — including
# changing it back afterwards, because chmod is gated on ownership rather than
# on write permission. That the privileged route does not work here is a
# property of the container hardening `docs/SECURITY.md` §10 requires, and a
# harness that needed it relaxed would be testing a different deployment.
artefact_store_mode() {
  "${COMPOSE[@]}" exec -T -e RP_MODE="$1" api node -e '
    const { readdirSync, chmodSync } = require("node:fs");
    const { join } = require("node:path");
    const mode = Number.parseInt(process.env.RP_MODE, 8);
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
      }
      chmodSync(directory, mode);
    };
    walk(process.env.REVIEWPLANE_ARTEFACT_PATH);
  '
}

# ---------------------------------------------------------------------------
step "Setup: bring up the stack the faults are injected into"
# ---------------------------------------------------------------------------

"${E2E_DIR}/generate-secrets.sh" --force
# shellcheck disable=SC1091
source "${COMPOSE_DIR}/.env"
export REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI
BOOTSTRAP_TOKEN="$(cat "${COMPOSE_DIR}/secrets/bootstrap_token")"

"${COMPOSE[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true
info "compose project: ${COMPOSE_PROJECT_NAME}"

"${COMPOSE[@]}" build --quiet api browser-worker tunnel-gateway dev-fixture
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 postgres api \
  || fail "postgres and the control plane did not become healthy"

# The gateway verifies connector identities against the control plane's
# connector authority and reads it once at start (ADR-0014), so it is exported
# before the gateway comes up rather than after.
CA_RESPONSE="$(api GET /api/v1/connectors/certificate-authority)"
field "${CA_RESPONSE}" 'data["certificate_pem"]' > "${COMPOSE_DIR}/tls/connector-ca.pem" \
  || fail "could not export the connector CA"
chmod 644 "${COMPOSE_DIR}/tls/connector-ca.pem"
cat "${COMPOSE_DIR}/tls/connector-ca.pem" "${COMPOSE_DIR}/tls/tunnel-ca.pem" \
  > "${COMPOSE_DIR}/tls/connector-trust.pem"
chmod 644 "${COMPOSE_DIR}/tls/connector-trust.pem"

"${COMPOSE[@]}" up -d --wait --wait-timeout 180 tunnel-gateway browser-worker \
  || fail "the tunnel gateway and browser worker did not start"

TOKEN_RESPONSE="$(api POST /api/v1/connectors/enrolment-tokens '{"max_uses":1,"expires_in_seconds":900}')"
ORGANISATION_ID="$(field "${TOKEN_RESPONSE}" 'data["organisation_id"]')" \
  || fail "the enrolment token named no organisation"
"${COMPOSE[@]}" exec -T postgres psql -U reviewplane -d reviewplane -q -c \
  "insert into projects (id, organisation_id, name, slug)
   values ('${PROJECT_ID}', '${ORGANISATION_ID}', 'Fixture', '${PROJECT_SLUG}')
   on conflict (id) do nothing" > /dev/null \
  || fail "could not create the project"
ENROLMENT_TOKEN="$(field "${TOKEN_RESPONSE}" 'data["enrolment_token"]')" \
  || fail "could not issue an enrolment token"
printf '%s' "${ENROLMENT_TOKEN}" > "${COMPOSE_DIR}/secrets/enrolment_token"
chmod 644 "${COMPOSE_DIR}/secrets/enrolment_token"
cp "${COMPOSE_DIR}/connector-config.yaml" "${COMPOSE_DIR}/connector-config.generated.yaml"

"${COMPOSE[@]}" up -d --wait --wait-timeout 180 dev-fixture \
  || fail "the development fixture did not start"
info "organisation ${ORGANISATION_ID}, project ${PROJECT_ID}"

connector_enrolled() { [[ "$(psql_scalar "select count(*) from connectors")" != "0" ]]; }
await 120 connector_enrolled > /dev/null || fail "the connector did not enrol within 120s"
CONNECTOR_ID="$(field "$(api GET /api/v1/connectors)" 'data[0]["id"]')" || fail "no connector enrolled"

# The workspace the connector reports. A publication names one, so this waits
# for the connector's own observation rather than writing a row: the scenario
# script learned that lesson the hard way (RVP-80) and this script does not
# repeat it.
workspace_observed() { [[ "$(psql_scalar "select count(*) from workspaces where project_id = '${PROJECT_ID}'")" != "0" ]]; }
await 180 workspace_observed > /dev/null || fail "the connector did not observe its workspace within 180s"
WORKSPACE_ID="$(psql_scalar "select id from workspaces where project_id = '${PROJECT_ID}' limit 1")"
FIXTURE_COMMIT="$(psql_scalar "select head_commit from workspaces where id = '${WORKSPACE_ID}'")"
info "connector ${CONNECTOR_ID}, workspace ${WORKSPACE_ID} at ${FIXTURE_COMMIT}"

WORKER_ID="$(field "$(api GET /api/v1/browser-workers)" 'data[0]["id"]')" || fail "no browser worker registered"
api PUT "/api/v1/browser-workers/${WORKER_ID}/assignments" "{\"project_ids\":[\"${PROJECT_ID}\"]}" > /dev/null \
  || fail "could not assign the browser worker to the project"

# The worker's own copy of its assignment converges up to one heartbeat later,
# and only an allocation observes it (`run.sh` records why at length). So the
# wait is an allocation attempt, and the session it eventually produces is the
# one the cases use.
SESSION_ID=""
worker_ready() {
  local probe status
  probe="$(api POST "/api/v1/projects/${PROJECT_ID}/browser-sessions" \
    '{"viewport":{"width":1440,"height":900,"device_scale_factor":1}}' 2>/dev/null || true)"
  status="$(field "${probe}" 'data["status"]' 2>/dev/null || true)"
  if [[ "${status}" == "READY" ]]; then
    local probe_id
    probe_id="$(field "${probe}" 'data["id"]' 2>/dev/null || true)"
    [[ -z "${probe_id}" ]] || api POST "/api/v1/browser-sessions/${probe_id}/terminate" '{"control_epoch":1}' > /dev/null 2>&1 || true
    return 0
  fi
  return 1
}
await 120 worker_ready > /dev/null || fail "the browser worker did not accept an allocation within 120s"

RESERVE_BODY="$(printf '{"organisation_id":"%s","viewport":{"width":1440,"height":900,"device_scale_factor":1},"allocate":false}' "${ORGANISATION_ID}")"
SESSION_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/browser-sessions" "${RESERVE_BODY}")"
SESSION_ID="$(field "${SESSION_RESPONSE}" 'data["id"]')" || fail "could not reserve a browser session"

PUBLISH_BODY="$(printf '{"connector_id":"%s","workspace_id":"%s","local_host":"127.0.0.1","local_port":4321,"protocol":"http","ttl_seconds":3600,"allowed_browser_session_ids":["%s"]}' \
  "${CONNECTOR_ID}" "${WORKSPACE_ID}" "${SESSION_ID}")"
PUBLISH_RESPONSE="$(api POST "/api/v1/projects/${PROJECT_ID}/published-services" "${PUBLISH_BODY}")"
SERVICE_ID="$(field "${PUBLISH_RESPONSE}" 'data["id"]')" || fail "publication failed: ${PUBLISH_RESPONSE}"

ALLOCATE_RESPONSE="$(api POST "/api/v1/browser-sessions/${SESSION_ID}/allocate" "{\"published_service_id\":\"${SERVICE_ID}\"}")"
[[ "$(field "${ALLOCATE_RESPONSE}" 'data["status"]')" == "READY" ]] \
  || fail "the session is not READY: ${ALLOCATE_RESPONSE}"
info "browser session ${SESSION_ID} is READY against ${SERVICE_ID}"

NAV_RESPONSE="$(session_command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/","wait_until":"load"}}')"
[[ "$(field "${NAV_RESPONSE}" 'data["ok"]')" == "True" ]] || fail "the baseline navigation failed: ${NAV_RESPONSE}"
info "baseline navigation succeeded"

# Four screenshots, all captured here while the session is healthy.
#
# Three of them are because a verification's evidence must not be the original
# screenshot of another finding (`docs/TESTING.md` §4, and
# `ReviewService.#requireOwnedEvidence`): one original per finding, and one
# unattached capture to submit as the after state.
#
# The fourth belongs to the worker-crash case and is taken here rather than
# there, because by the time that case runs the connector case has already
# stopped the development environment and the session is `DEGRADED`, so a
# capture would be refused `BROWSER_SESSION_NOT_ACTIVE`. Taking it early costs
# the case nothing: the row is "worker crash **after** screenshot upload", the
# upload is what has to have happened first, and the crash is what the case
# injects.
ORIGINAL_A="$(capture_screenshot)"
ORIGINAL_B="$(capture_screenshot)"
AFTER_ARTEFACT="$(capture_screenshot)"
CRASH_ARTEFACT="$(capture_screenshot)"
info "captured screenshots ${ORIGINAL_A}, ${ORIGINAL_B}, ${AFTER_ARTEFACT}, ${CRASH_ARTEFACT}"

REVIEW_BODY="$(printf '{"slug":"fault-injection","title":"Fault injection","captured_branch":"main","captured_commit":"%s","captured_workspace_id":"%s","source_browser_session_id":"%s"}' \
  "${FIXTURE_COMMIT}" "${WORKSPACE_ID}" "${SESSION_ID}")"
REVIEW_ID="$(field "$(api POST "/api/v1/projects/${PROJECT_ID}/reviews" "${REVIEW_BODY}")" 'data["id"]')" \
  || fail "could not create the review"

finding_body() {
  printf '{"title":%s,"severity":"medium","url":"/","viewport":{"width":1440,"height":900,"device_scale_factor":1},"scroll_position":{"x":0,"y":0},"captured_commit":"%s","screenshot_artefact_id":"%s"}' \
    "$(json_string "$1")" "${FIXTURE_COMMIT}" "$2"
}
# `createFinding` answers `{finding, annotations}` rather than the finding
# alone: a finding and the geometry that explains it are written in one
# transaction and returned together.
FINDING_STORE="$(field "$(api POST "/api/v1/reviews/${REVIEW_ID}/findings" "$(finding_body 'Store availability' "${ORIGINAL_A}")")" 'data["finding"]["id"]')" \
  || fail "could not create the first finding"
FINDING_DUP="$(field "$(api POST "/api/v1/reviews/${REVIEW_ID}/findings" "$(finding_body 'Duplicate verification' "${ORIGINAL_B}")")" 'data["finding"]["id"]')" \
  || fail "could not create the second finding"
info "review ${REVIEW_ID} with findings ${FINDING_STORE} and ${FINDING_DUP}"

# A commit that is not the finding's captured commit: a verification must name
# a different one, which is a domain rule rather than a convention here.
FIX_COMMIT="$(printf '%s' "${FIXTURE_COMMIT}" | python3 -c '
import sys
value = sys.stdin.read().strip()
# Flip the last hexadecimal digit, so the shape stays valid and the value differs.
sys.stdout.write(value[:-1] + ("0" if value[-1] != "0" else "1"))
')"
VERIFICATION_BODY="$(printf '{"summary":"Fault-injection verification. The change is a fixture no-op; what is under test is the control plane, not the fix.","branch":"main","commit":"%s","tested_viewports":[{"width":1440,"height":900,"device_scale_factor":1}],"checks":{"reproduced_before":true,"console_errors_reviewed":true,"network_failures_reviewed":true},"artefact_ids":["%s"]}' \
  "${FIX_COMMIT}" "${AFTER_ARTEFACT}")"

# ---------------------------------------------------------------------------
CURRENT_CASE="API restart during live view"
step "1. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): the client reconnects and refreshes state.
#
# The client is a WebSocket viewer speaking the live protocol, run in its own
# container so that restarting `api` does not also kill the observer. It does
# the handshake and frame parsing itself over a plain socket rather than
# importing `ws`: the runtime image's dependency tree is a build output and not
# a contract, and a case that needs a package to be hoisted where it happens to
# be today is a case that fails for the wrong reason later.
#
# `apps/web/test/ui/` proves the *browser* client's half of this row against a
# restartable stub. What that suite cannot show is the deployed control plane
# being restarted under a live viewer, which is this.

# The program is deliberately plain CommonJS inside an async function, and
# `require` rather than `import`. `node -e` decides between CommonJS and modules
# by detection; that decision is not stable across the Node builds this
# repository runs — the same shape of program evaluated fine through `docker
# compose exec` and failed with "await is only valid in async functions" through
# `docker compose run` — and a fixture that depends on it fails for a reason
# that has nothing to do with what it was testing. An async function needs no
# detection to be right.
#
# Every line it emits carries an `RPFAULT ` marker. `docker compose run` prints
# its own build and container lines on the same stream, and a parser that
# assumed it owned stdout would read a Docker progress line as a verdict.
LIVE_CLIENT_PROGRAM='
(async () => {
  const net = require("node:net");
  const crypto = require("node:crypto");

  const token = process.env.RP_TOKEN;
  const sessionId = process.env.RP_SESSION;
  const say = (record) => process.stdout.write(`RPFAULT ${JSON.stringify(record)}\n`);

  // Reads one text message from a live stream, or reports why it could not.
  // Server-to-client frames are never masked, so the header is the opcode and
  // then a length that is inline, two bytes or eight.
  function attach(timeoutMs) {
    return new Promise((resolve) => {
      const socket = net.connect(8080, "api");
      let phase = "handshake";
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: `timed out in ${phase}` }), timeoutMs);
      socket.on("error", (error) => finish({ ok: false, reason: `${phase}: ${error.message}` }));
      socket.on("close", () => finish({ ok: false, reason: `${phase}: closed before a message arrived` }));
      socket.on("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write(
          `GET /ws/v1/browser-sessions/${sessionId}/live?mode=session_room HTTP/1.1\r\n` +
          "Host: api:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          `Authorization: Bearer ${token}\r\n\r\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (phase === "handshake") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buffer.subarray(0, end).toString("latin1");
          if (!/^HTTP\/1\.1 101/.test(head)) {
            finish({ ok: false, reason: `handshake answered ${head.split("\r\n")[0]}` });
            return;
          }
          buffer = buffer.subarray(end + 4);
          phase = "frames";
        }
        while (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          const inline = buffer[1] & 0x7f;
          let offset = 2;
          let length = inline;
          if (inline === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (inline === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 1) {
            try {
              finish({ ok: true, type: JSON.parse(payload.toString("utf8")).type });
            } catch (error) {
              finish({ ok: false, reason: `a text frame was not JSON: ${error.message}` });
            }
            return;
          }
          if (opcode === 8) {
            finish({ ok: false, reason: "the server closed the stream" });
            return;
          }
        }
      });
    });
  }

  const first = await attach(30000);
  say({ phase: "attached", result: first });
  if (!first.ok || first.type !== "live.session_state") return false;

  // The restart happens while this waits. Reattaching is bounded and every
  // attempt is counted, so a run that never recovered says how hard it tried.
  const deadline = Date.now() + 150000;
  let attempts = 0;
  let second = { ok: false, reason: "never attempted" };
  while (Date.now() < deadline) {
    attempts += 1;
    second = await attach(10000);
    if (second.ok && second.type === "live.session_state") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const ok = second.ok && second.type === "live.session_state";
  say({ phase: "verdict", ok, attempts, result: second });
  return ok;
})().then(
  (ok) => {
    if (!ok) {
      process.stdout.write(`RPFAULT ${JSON.stringify({ phase: "verdict", ok: false })}\n`);
    }
    process.exitCode = ok ? 0 : 1;
  },
  (error) => {
    process.stdout.write(
      `RPFAULT ${JSON.stringify({ phase: "verdict", ok: false, reason: String((error && error.stack) || error) })}\n`,
    );
    process.exitCode = 1;
  },
);
'

LIVE_OUT="${EVIDENCE}/live-restart.ndjson"
LIVE_ERR="${EVIDENCE}/live-restart.err"
"${COMPOSE[@]}" run --rm --no-deps --quiet-pull -T \
  -e RP_TOKEN="${BOOTSTRAP_TOKEN}" -e RP_SESSION="${SESSION_ID}" \
  api node -e "${LIVE_CLIENT_PROGRAM}" > "${LIVE_OUT}" 2> "${LIVE_ERR}" &
LIVE_PID=$!

# Only marked lines are read, and the marker is what makes the read safe.
live_event() { grep -h '^RPFAULT ' "${LIVE_OUT}" 2> /dev/null | sed 's/^RPFAULT //'; }
live_attached() { live_event | grep -q '"phase":"attached"'; }
await 150 live_attached > /dev/null \
  || fail "the live viewer did not attach within 150s: $(tail -c 4000 "${LIVE_OUT}" "${LIVE_ERR}" 2>/dev/null)"
live_event | grep -q '"phase":"attached","result":{"ok":true' \
  || fail "the live viewer did not receive session state before the restart: $(live_event)"
info "live viewer attached and received session state"

"${COMPOSE[@]}" restart api > /dev/null 2>&1 || fail "could not restart the api service"
info "api restarted under the live viewer"

if ! wait "${LIVE_PID}"; then
  fail "the live viewer did not reconnect and refresh state after the api restart: $(live_event)"
fi
LIVE_ATTEMPTS="$(live_event | python3 -c '
import json, sys

attempts = "?"
for line in sys.stdin:
    record = json.loads(line)
    if record.get("phase") == "verdict":
        attempts = str(record.get("attempts", "?"))
sys.stdout.write(attempts)
')"
"${COMPOSE[@]}" up -d --wait --wait-timeout 180 api > /dev/null 2>&1 \
  || fail "the api service did not become healthy again after the restart"
record_case "${CURRENT_CASE}" pass \
  "a live viewer received live.session_state, the api was restarted under it, and it reattached and received session state again after ${LIVE_ATTEMPTS} attempt(s)"

# ---------------------------------------------------------------------------
CURRENT_CASE="Database unavailable"
step "2. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): "State changes denied; no unaudited continuation." That is the
# whole of the row, and this case asserts exactly it and no more.
#
# It deliberately does **not** gate on the control plane surviving the outage.
# The §11 row that requires the process to stay up — "PostgreSQL not yet ready
# at start-up: the API reports itself not ready, keeps answering liveness, and
# does not exit into a restart loop" — is about start-up and is owned by
# `pnpm test:install`. Losing the database *mid-run* is a different event and
# this row says nothing about it.
#
# What happens to the process is nevertheless **recorded**, because it is worth
# knowing and because an observation that is dropped is indistinguishable from
# one that was fine. On the first full run of this script the control plane
# exited on an unhandled rejection from the connector control channel
# (`modules/connectors/channel.ts`: `void work` attaches no rejection handler)
# and was brought back by its restart policy; later runs did not, which makes it
# intermittent and makes a passing run no evidence at all. That is **RVP-103**,
# filed with the evidence, and it is not this case's to gate — so the restart
# count and the refusal's shape are reported in the run summary rather than
# silently swallowed or silently turned into a failure of the wrong row.
# RVP-103's acceptance criteria include tightening this case from recording to
# gating once the defect is fixed.

api_restart_count() {
  local container
  container="$("${COMPOSE[@]}" ps -q api 2>/dev/null | head -1)"
  if [[ -z "${container}" ]]; then
    printf 'unknown'
    return 0
  fi
  docker inspect --format '{{.RestartCount}}' "${container}" 2>/dev/null || printf 'unknown'
}

EVENTS_BEFORE="$(psql_scalar "select count(*) from events")"
PROJECT_EVENTS_BEFORE="$(psql_scalar "select count(*) from events where type like 'project.%'")"
RESTARTS_BEFORE="$(api_restart_count)"
DOOMED_SLUG="denied-while-the-database-was-down"
"${COMPOSE[@]}" stop -t 10 postgres > /dev/null 2>&1 || fail "could not stop postgres"
info "postgres stopped; ${EVENTS_BEFORE} events recorded before the outage"

DOWN_CREATE="$(api POST "/api/v1/organisations/${ORGANISATION_ID}/projects" \
  "{\"name\":\"Denied\",\"slug\":\"${DOOMED_SLUG}\"}")"
DOWN_STATUS="$(http_status "${DOWN_CREATE}")"
DOWN_CODE="$(error_code "${DOWN_CREATE}")"
(( DOWN_STATUS >= 400 || DOWN_STATUS == 0 )) \
  || fail "a project was created with the database down: ${DOWN_CREATE}"

# A refusal must not carry deployment data (`docs/SECURITY.md` §18). The
# database URL carries a password, and a driver error that leaked it would put
# it in every log an operator pastes into an issue.
DOWN_BODY="$(http_body "${DOWN_CREATE}")"
for secret in "postgres://" "password" "5432"; do
  if [[ "${DOWN_BODY}" == *"${secret}"* ]]; then
    fail "the refusal with the database down carried '${secret}': ${DOWN_BODY}"
  fi
done

# Recorded, not gated: whether the refusal named a stable error code. A 500 with
# no code is a worse answer than a stable refusal and it is still a refusal,
# which is what this row asks for.
if [[ -z "${DOWN_CODE}" ]]; then
  warn "the refusal carried no stable error code (HTTP ${DOWN_STATUS}); recorded, not gated"
fi

"${COMPOSE[@]}" up -d --wait --wait-timeout 300 postgres > /dev/null 2>&1 \
  || fail "postgres did not come back"
recovered() { [[ "$(http_status "$(api GET /api/v1/connectors)")" == "200" ]]; }
await 240 recovered > /dev/null || fail "the control plane did not recover within 240s of the database returning"

RESTARTS_AFTER="$(api_restart_count)"
if [[ "${RESTARTS_AFTER}" != "${RESTARTS_BEFORE}" ]]; then
  warn "the api container restarted during the outage (${RESTARTS_BEFORE} -> ${RESTARTS_AFTER}); recorded, not gated — the §11 row that gates on this is about start-up and is owned by pnpm test:install"
fi

# "No unaudited continuation": nothing was half-written, and nothing was
# recorded about the attempt that was refused. Both assertions are on the
# **absence** of a row, because a response code alone would pass against code
# that refused the caller and wrote the row anyway.
LEFTOVER="$(psql_scalar "select count(*) from projects where slug = '${DOOMED_SLUG}'")"
[[ "${LEFTOVER}" == "0" ]] \
  || fail "the refused creation left ${LEFTOVER} project row(s) behind"
PROJECT_EVENTS_AFTER="$(psql_scalar "select count(*) from events where type like 'project.%'")"
[[ "${PROJECT_EVENTS_AFTER}" == "${PROJECT_EVENTS_BEFORE}" ]] \
  || fail "the refused creation recorded $((PROJECT_EVENTS_AFTER - PROJECT_EVENTS_BEFORE)) project event(s)"

RETRY="$(api POST "/api/v1/organisations/${ORGANISATION_ID}/projects" \
  "{\"name\":\"Denied\",\"slug\":\"${DOOMED_SLUG}\"}")"
[[ "$(http_status "${RETRY}")" == "201" ]] \
  || fail "the same creation was refused after the database came back: ${RETRY}"
record_case "${CURRENT_CASE}" pass \
  "the creation was refused (HTTP ${DOWN_STATUS}, code ${DOWN_CODE:-none}) with no credential in the body; no row and no project event survived the refusal (${EVENTS_BEFORE} events before it); the same call succeeded once the database returned. Recorded and not gated: api container restarts ${RESTARTS_BEFORE} -> ${RESTARTS_AFTER}"

# ---------------------------------------------------------------------------
CURRENT_CASE="Artefact store unavailable"
step "3. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): verification remains incomplete, the refusal names the store,
# and the state is unchanged and retryable.
#
# The store is made unavailable the way it fails in production — a volume that
# is there and cannot be written — rather than by pointing the server at a path
# that does not exist. A read succeeds against a full or read-only volume, which
# is why `reviewplane status` probes with a write and why this case does too.

STORE_CHMOD="$(artefact_store_mode 0500 2>&1)" \
  || fail "could not make the artefact store unwritable: ${STORE_CHMOD}"
info "artefact store made unwritable"

STORE_STATUS_JSON="$("${COMPOSE[@]}" exec -T api reviewplane status --json 2>/dev/null || true)"
STORE_EXIT=0
"${COMPOSE[@]}" exec -T api reviewplane status > /dev/null 2>&1 || STORE_EXIT=$?
[[ "${STORE_EXIT}" == "4" ]] \
  || fail "reviewplane status exited ${STORE_EXIT} with the artefact store unwritable, not 4 (docs/OPERATIONS.md §3)"
STORE_AVAILABLE="$(python3 -c '
import json, sys
try:
    print(json.loads(sys.argv[1])["artefact_store"]["available"])
except Exception:
    print("unreadable")
' "${STORE_STATUS_JSON}")"
[[ "${STORE_AVAILABLE}" == "False" ]] \
  || fail "reviewplane status reports the artefact store as ${STORE_AVAILABLE} while it is unwritable"

STORE_REFUSAL="$(api POST "/api/v1/findings/${FINDING_STORE}/verifications" "${VERIFICATION_BODY}")"
STORE_CODE="$(error_code "${STORE_REFUSAL}")"
[[ "${STORE_CODE}" == "ARTEFACT_STORE_UNAVAILABLE" ]] \
  || fail "the verification answered ${STORE_CODE:-a success} with the store unavailable, not ARTEFACT_STORE_UNAVAILABLE: ${STORE_REFUSAL}"

# The refusal names the store and not the deployment (`docs/SECURITY.md` §18).
STORE_BODY="$(http_body "${STORE_REFUSAL}")"
for leak in "/var/lib/reviewplane" "EACCES" "ENOENT" "errno"; do
  if [[ "${STORE_BODY}" == *"${leak}"* ]]; then
    fail "the store-unavailable refusal carried '${leak}': ${STORE_BODY}"
  fi
done

# "Verification remains incomplete": no record at all. The assertion is on the
# absence of a row, because a response code alone would pass against code that
# refused the caller and wrote the row anyway.
STORE_ROWS="$(psql_scalar "select count(*) from verifications where finding_id = '${FINDING_STORE}'")"
[[ "${STORE_ROWS}" == "0" ]] \
  || fail "${STORE_ROWS} verification row(s) were written while the store was unavailable"

STORE_RESTORE="$(artefact_store_mode 0700 2>&1)" \
  || fail "could not restore the artefact store: ${STORE_RESTORE}"

# "Retryable": the same submission, unchanged, now succeeds.
STORE_RETRY="$(api POST "/api/v1/findings/${FINDING_STORE}/verifications" "${VERIFICATION_BODY}")"
[[ "$(http_status "${STORE_RETRY}")" == "201" ]] \
  || fail "the identical submission was still refused after the store came back: ${STORE_RETRY}"
STORE_ROWS_AFTER="$(psql_scalar "select count(*) from verifications where finding_id = '${FINDING_STORE}' and status = 'submitted'")"
[[ "${STORE_ROWS_AFTER}" == "1" ]] \
  || fail "the retry produced ${STORE_ROWS_AFTER} current verifications, not one"
record_case "${CURRENT_CASE}" pass \
  "reviewplane status exited 4 and reported the store unavailable; the verification was refused ARTEFACT_STORE_UNAVAILABLE with no path or errno in the body; no row was written; the identical submission succeeded once the store returned"

# ---------------------------------------------------------------------------
CURRENT_CASE="Duplicate verification request"
step "4. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): one verification record.
#
# Two identical submissions are issued at once against one finding. The service
# locks the finding first, so the ordinary path serialises; migration 0150's
# partial unique index `verifications_one_current_per_finding` is the backstop
# for the path the lock does not cover. Either way the finding must end holding
# exactly one current claim, with anything it replaced kept and marked
# superseded — a history, not a deletion.

DUP_ONE="${EVIDENCE}/duplicate-verification-1.json"
DUP_TWO="${EVIDENCE}/duplicate-verification-2.json"
api POST "/api/v1/findings/${FINDING_DUP}/verifications" "${VERIFICATION_BODY}" > "${DUP_ONE}" 2>&1 &
DUP_PID_ONE=$!
api POST "/api/v1/findings/${FINDING_DUP}/verifications" "${VERIFICATION_BODY}" > "${DUP_TWO}" 2>&1 &
DUP_PID_TWO=$!
wait "${DUP_PID_ONE}" || true
wait "${DUP_PID_TWO}" || true

DUP_CURRENT="$(psql_scalar "select count(*) from verifications where finding_id = '${FINDING_DUP}' and status = 'submitted'")"
[[ "${DUP_CURRENT}" == "1" ]] \
  || fail "the finding holds ${DUP_CURRENT} current verifications after two identical submissions, not one"
DUP_TOTAL="$(psql_scalar "select count(*) from verifications where finding_id = '${FINDING_DUP}'")"
DUP_ORPHANED="$(psql_scalar "select count(*) from verifications where finding_id = '${FINDING_DUP}' and status <> 'submitted' and superseded_by_verification_id is null")"
[[ "${DUP_ORPHANED}" == "0" ]] \
  || fail "${DUP_ORPHANED} non-current verification(s) name no successor, so the history has a hole"

# The read surface must agree with the table: exactly one claim is current.
DUP_READ="$(api GET "/api/v1/findings/${FINDING_DUP}/verification")"
[[ "$(http_status "${DUP_READ}")" == "200" ]] \
  || fail "the current verification is unreadable after the duplicate submissions: ${DUP_READ}"
record_case "${CURRENT_CASE}" pass \
  "two concurrent identical submissions left exactly one current verification out of ${DUP_TOTAL} row(s), every superseded row naming its successor, and the read surface agreeing"

# ---------------------------------------------------------------------------
CURRENT_CASE="Connector disconnect during navigation"
step "5. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): the action fails clearly, the route is unavailable, and the
# session remains diagnosable.

"${COMPOSE[@]}" stop -t 5 dev-fixture > /dev/null 2>&1 \
  || fail "could not stop the development fixture"
info "development fixture (and its connector) stopped"

DISCONNECT_STARTED="$(now_ms)"
NAV_DOWN="$(session_command 1 '{"command":"navigate","timeout_ms":30000,"navigate":{"url":"/","wait_until":"load"}}')"
NAV_ELAPSED_MS=$(( $(now_ms) - DISCONNECT_STARTED ))

# "Fails clearly" is asserted as *not a successful page load*, and the bound is
# asserted separately: the failure this row guards against is a hang, and a
# request that eventually returns an error after five minutes has already cost
# the user the session.
(( NAV_ELAPSED_MS < 90000 )) \
  || fail "navigation through the offline connector took ${NAV_ELAPSED_MS}ms, which is a hang rather than a refusal"
NAV_OK="$(field "${NAV_DOWN}" 'data["ok"]' 2>/dev/null || printf 'refused')"
NAV_HTTP="$(field "${NAV_DOWN}" 'data.get("navigation", {}).get("http_status")' 2>/dev/null || printf '')"
if [[ "${NAV_OK}" == "True" && -n "${NAV_HTTP}" && "${NAV_HTTP}" -lt 400 ]]; then
  fail "navigation reported a successful load (${NAV_HTTP}) with the connector offline: ${NAV_DOWN}"
fi
info "navigation failed within ${NAV_ELAPSED_MS}ms (ok=${NAV_OK}, http=${NAV_HTTP:-none})"

# "Route unavailable" is asserted against the documented stable code rather
# than against a timer: a publication through a connector whose channel is gone
# is refused with CONNECTOR_OFFLINE, and that answer is immediate because the
# control plane knows the socket closed.
OFFLINE_PUBLISH="$(api POST "/api/v1/projects/${PROJECT_ID}/published-services" "${PUBLISH_BODY}")"
OFFLINE_CODE="$(error_code "${OFFLINE_PUBLISH}")"
[[ "${OFFLINE_CODE}" == "CONNECTOR_OFFLINE" ]] \
  || fail "publication through the offline connector answered ${OFFLINE_CODE:-a success}, not CONNECTOR_OFFLINE: ${OFFLINE_PUBLISH}"

# "Session remains diagnosable": the session is still readable and its timeline
# still answers. A session that became unreadable when its route went away
# would leave an operator with nothing to look at.
SESSION_AFTER="$(api GET "/api/v1/browser-sessions/${SESSION_ID}")"
SESSION_STATUS="$(field "${SESSION_AFTER}" 'data["status"]')" \
  || fail "the browser session became unreadable after the connector went away: ${SESSION_AFTER}"
TIMELINE="$(api GET "/api/v1/browser-sessions/${SESSION_ID}/timeline")"
[[ "$(http_status "${TIMELINE}")" == "200" ]] \
  || fail "the session timeline is unreadable after the disconnect: ${TIMELINE}"

# The connector is deliberately **not** brought back, and this case asserts no
# recovery. Recovery is a different row of §11 — "connector process killed and
# restarted: route resumes under the same route_id, no operator action" — and it
# already has an owner that can prove the strong form of it:
# `apps/server/test/connector-reconnect.test.ts` and
# `services/connector/internal/protocolsim`. What this script could show is
# weaker than what they already show, because the fixture's connector state
# lives on a tmpfs and its enrolment token is single-use, so a restarted fixture
# enrols as a *new* connector. Calling that "the connector reconnected" would be
# an overstatement, and an overstated gate is the failure this whole issue is
# about. So the case ends here and the run continues without a connector; no
# case after this one needs one.
record_case "${CURRENT_CASE}" pass \
  "navigation failed in ${NAV_ELAPSED_MS}ms rather than hanging; publication answered CONNECTOR_OFFLINE; the session stayed readable at ${SESSION_STATUS} with a readable timeline. Reconnection is a separate §11 row and is not asserted here"

# ---------------------------------------------------------------------------
CURRENT_CASE="Worker crash after screenshot upload"
step "6. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Expected (§11): the uploaded evidence remains and the session is marked
# failed.
#
# This case is last because it leaves the worker dead. The crash is a SIGKILL
# with the restart policy removed first: `restart: unless-stopped` would
# otherwise bring the worker back within seconds, and a worker that came back is
# not the failure this row is about.

# `CRASH_ARTEFACT` was captured and uploaded during setup; the setup block says
# why it could not be captured here. Its state is re-read now rather than
# assumed, so that "unchanged across the crash" is measured against what the
# store actually held a moment before it.
CRASH_DIGEST="$(psql_scalar "select sha256 from artefacts where id = '${CRASH_ARTEFACT}'")"
CRASH_SIZE="$(psql_scalar "select size_bytes from artefacts where id = '${CRASH_ARTEFACT}'")"
CRASH_STATE="$(psql_scalar "select state from artefacts where id = '${CRASH_ARTEFACT}'")"
[[ "${CRASH_STATE}" == "available" ]] \
  || fail "the screenshot is ${CRASH_STATE} rather than available before the crash"
info "uploaded ${CRASH_ARTEFACT} (${CRASH_SIZE} bytes, ${CRASH_DIGEST:0:12}…)"

WORKER_CONTAINER="$("${COMPOSE[@]}" ps -q browser-worker)"
[[ -n "${WORKER_CONTAINER}" ]] || fail "the browser worker container could not be identified"
docker update --restart=no "${WORKER_CONTAINER}" > /dev/null \
  || fail "could not remove the worker's restart policy"
docker kill --signal=SIGKILL "${WORKER_CONTAINER}" > /dev/null \
  || fail "could not kill the browser worker"
info "browser worker killed with SIGKILL"

# The evidence survives the process that produced it. Both halves: the metadata
# is unchanged, and the bytes are still reachable through a grant — a row that
# still says `available` over a store that lost the object is exactly the
# dishonesty this assertion exists to catch.
AFTER_STATE="$(psql_scalar "select state from artefacts where id = '${CRASH_ARTEFACT}'")"
AFTER_DIGEST="$(psql_scalar "select sha256 from artefacts where id = '${CRASH_ARTEFACT}'")"
[[ "${AFTER_STATE}" == "available" && "${AFTER_DIGEST}" == "${CRASH_DIGEST}" ]] \
  || fail "the artefact is ${AFTER_STATE} with digest ${AFTER_DIGEST} after the crash, not available/${CRASH_DIGEST}"
FETCHED_BYTES="$("${COMPOSE[@]}" exec -T -e RP_ID="${CRASH_ARTEFACT}" -e RP_TOKEN="${BOOTSTRAP_TOKEN}" api node -e '
    void (async () => {
      const authorization = `Bearer ${process.env.RP_TOKEN}`;
      const granted = await fetch(`http://127.0.0.1:8080/api/v1/artefacts/${process.env.RP_ID}/grants`, {
        method: "POST", headers: { authorization },
      });
      if (!granted.ok) { process.stdout.write("0"); return; }
      const grant = (await granted.json()).data;
      const response = await fetch(`http://127.0.0.1:8080${grant.url}`, { headers: { authorization } });
      if (!response.ok) { process.stdout.write("0"); return; }
      process.stdout.write(String((await response.arrayBuffer()).byteLength));
    })();
  ' | tr -d '\r\n')"
[[ "${FETCHED_BYTES}" == "${CRASH_SIZE}" ]] \
  || fail "the evidence bytes read back as ${FETCHED_BYTES} rather than ${CRASH_SIZE} after the worker crash"

session_failed() {
  [[ "$(psql_scalar "select status from browser_sessions where id = '${SESSION_ID}'")" == "FAILED" ]]
}
FAILED_AFTER="$(await "${WORKER_LOSS_BOUND_SECONDS}" session_failed)" || fail "the session was not reconciled to FAILED within ${WORKER_LOSS_BOUND_SECONDS}s of the worker crash; it is $(psql_scalar "select status from browser_sessions where id = '${SESSION_ID}'")"
# The audit record, named exactly. The reconciler records the *status move* —
# `browser_session.failed` with `trigger: reconciliation` — and not a generic
# `browser_session.reconciled`, which the same module emits only for an orphan
# context it terminated. The assertion names this session and this trigger,
# because "some reconciliation event exists somewhere" would pass on an event
# about a different session in a run that has produced several.
RECONCILED_EVENTS="$(psql_scalar "
  select count(*) from events
   where type = 'browser_session.failed'
     and payload->>'trigger' = 'reconciliation'
     and correlation->>'browser_session_id' = '${SESSION_ID}'")"
(( RECONCILED_EVENTS > 0 )) \
  || fail "the session was failed with no browser_session.failed(trigger=reconciliation) event naming it; every state change must be audited"
record_case "${CURRENT_CASE}" pass \
  "the uploaded screenshot kept its state, digest and ${CRASH_SIZE} bytes across a SIGKILL of the worker, and the session was reconciled to FAILED ${FAILED_AFTER}s later with a browser_session.failed event naming it and the reconciliation that caused it"

# ---------------------------------------------------------------------------
CURRENT_CASE="Retention deletion partial failure"
step "7. ${CURRENT_CASE}"
# ---------------------------------------------------------------------------
# Not applicable in Stage 1, and asserted to be rather than omitted.
#
# `docs/ROADMAP.md` §4 places the retention policy in Stage 2, so this build has
# no retention deletion for a partial failure to happen to. The claim is checked
# against the protocol schema rather than asserted in prose: `job_kind` is the
# closed enumeration of the durable work the runner understands, and if a
# retention job ever appears in it this case fails and has to be written.
#
# A "not applicable" that nothing checks is a comment, and a comment is what
# every silently dropped matrix row started as.

RETENTION_KINDS="$(python3 -c '
import json, sys

schema = json.load(open(sys.argv[1]))
kinds = schema["$defs"]["job_kind"]["enum"]
matches = [kind for kind in kinds if "reten" in kind or "delet" in kind or "purge" in kind]
sys.stdout.write("\n".join(matches))
' "${SCHEMA_DIR}/platform/v1.schema.json")"
if [[ -n "${RETENTION_KINDS}" ]]; then
  fail "job_kind now names $(printf '%s' "${RETENTION_KINDS}" | tr '\n' ' '), so retention deletion exists and this case must be written rather than recorded as not applicable"
fi
RETENTION_JOB_ROWS="$(psql_scalar "select count(*) from jobs where kind like '%reten%' or kind like '%delet%'")"
[[ "${RETENTION_JOB_ROWS}" == "0" ]] \
  || fail "${RETENTION_JOB_ROWS} retention-shaped job row(s) exist, so this case is applicable after all"
record_case "${CURRENT_CASE}" "not applicable" \
  "Stage 1 has no retention deletion: job_kind in packages/protocol/schemas/platform/v1.schema.json names none, and no retention-shaped job row exists. The retention policy is docs/ROADMAP.md §4, Stage 2. This assertion fails the moment retention arrives"

# ---------------------------------------------------------------------------
step "Fault-injection matrix complete"
# ---------------------------------------------------------------------------
CURRENT_CASE="report"
diagnose
write_report "PASSED"
info "evidence: ${EVIDENCE}"
[[ "${CASE_FAILURES}" -eq 0 ]] || exit 1
