#!/usr/bin/env bash
#
# Regenerates the Stage 0 upgrade fixture in this directory (RVP-56).
#
# The fixture is a previous-stage installation frozen for the Stage 1 upgrade
# test: a PostgreSQL dump at the Stage 0 migration head, the artefact-store
# files that dump's rows reference, and a manifest naming the product commit,
# the schema version, the inventory and the checksums.
#
# What produces it is the product, not this script. It starts a disposable
# PostgreSQL, runs `apps/mcp-server/scripts/capture-stage0-fixture.ts` in the
# browser worker's own image under the container controls of
# `deploy/compose/compose.yaml`, and that driver runs one complete product loop
# — human captures and annotates, agent claims, changes the application,
# captures after evidence and submits verification — against the real
# control-plane process, the real MCP server and a real Chromium worker.
# This script only dumps what the loop wrote and describes it.
#
# Two things it refuses to carry:
#
#   * key material. `connector_tls_material` holds the connector certificate
#     authority's private key, so its rows are excluded from the dump and the
#     exclusion is asserted afterwards rather than trusted. `docs/SECURITY.md`
#     §20 and RVP-56 both make silent inclusion of key material a defect.
#   * anything large. Screenshots only; no traces, no videos, no live frames.
#
# Usage:  bash test/fixtures/stage0/capture.sh
# Verify: bash test/fixtures/stage0/verify.sh

set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${FIXTURE_DIR}/../../.." && pwd)"

# The Stage 0 product commit the fixture's behaviour comes from. It is recorded
# beside the capture-time commit because the commit that adds this tooling is a
# descendant of it that changes no product code.
STAGE0_COMMIT="${REVIEWPLANE_FIXTURE_STAGE0_COMMIT:-ccd3c9dc41a0c61ea3894580b92dde948fb5763a}"

IMAGE="reviewplane/browser-worker-test:local"
RUN_ID="stage0-fixture-$(date +%s)-$$"
NETWORK="${RUN_ID}-net"
POSTGRES="${RUN_ID}-postgres"
POSTGRES_PASSWORD="reviewplane-fixture"
POSTGRES_IMAGE="postgres:18-alpine"

cleanup() {
  # --volumes as well as --force: the image declares a volume for its data
  # directory, and removing the container without it leaves an anonymous volume
  # behind on every run.
  docker rm --force --volumes "${POSTGRES}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for tool in docker python3 git; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "${tool} is required" >&2; exit 1; }
done

if [[ ! -d "${REPO}/apps/mcp-server/node_modules" ]]; then
  echo "run pnpm install first: the driver runs from the working tree" >&2
  exit 1
fi

echo "==> building ${IMAGE}"
docker build \
  --file "${REPO}/apps/browser-worker/Dockerfile" \
  --target browser-base \
  --tag "${IMAGE}" \
  "${REPO}"

echo "==> creating the internal network ${NETWORK}"
docker network create --internal "${NETWORK}" >/dev/null

echo "==> starting PostgreSQL (${POSTGRES_IMAGE})"
docker run --detach \
  --name "${POSTGRES}" \
  --network "${NETWORK}" \
  --env "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  --tmpfs /var/lib/postgresql \
  "${POSTGRES_IMAGE}" -c fsync=off >/dev/null

echo "==> waiting for PostgreSQL"
# A real query is the readiness signal, not pg_isready: the image runs a
# temporary server during initialisation and restarts it, so a socket that
# accepts once can refuse a second later.
ready=0
for _ in $(seq 1 60); do
  if docker exec "${POSTGRES}" psql -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "${ready}" -eq 1 ]] || { echo "PostgreSQL did not become ready" >&2; exit 1; }

echo "==> running the Stage 0 loop under the deployed container controls"
# The controls are the ones `apps/mcp-server/scripts/run-integration-tests.sh`
# applies, for the same reason: the worker executes untrusted page content, and
# a capture taken with the sandbox off would not be evidence of what the product
# does (`docs/SECURITY.md` §10).
docker run --rm \
  --network "${NETWORK}" \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --security-opt no-new-privileges \
  --security-opt "seccomp=${REPO}/deploy/compose/browser-worker-seccomp.json" \
  --shm-size 1g \
  --env HOME=/tmp \
  --env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  --env "REVIEWPLANE_TEST_DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES}:5432/postgres" \
  --env "REVIEWPLANE_FIXTURE_OUT=/work/test/fixtures/stage0" \
  --volume "${REPO}:/work" \
  --workdir /work/apps/mcp-server \
  "${IMAGE}" \
  node --conditions=development scripts/capture-stage0-fixture.ts

test -s "${FIXTURE_DIR}/.summary.json" || { echo "the capture wrote no summary" >&2; exit 1; }

echo "==> dumping the database"
# --column-inserts keeps the dump reviewable in a pull request and independent
# of column order; the fixture is small enough that the slower restore does not
# matter. --no-owner and --no-privileges let it restore into any empty database,
# which is what a restore on another host is.
docker exec "${POSTGRES}" pg_dump \
  --username postgres \
  --dbname postgres \
  --no-owner \
  --no-privileges \
  --column-inserts \
  --exclude-table-data=connector_tls_material \
  > "${FIXTURE_DIR}/database.sql"

# Fail closed rather than warn: a fixture that carried a private key would be a
# committed secret, and it is cheaper to refuse here than to revoke later.
if grep -qi -e "BEGIN .*PRIVATE KEY" -e "^INSERT INTO public.connector_tls_material" "${FIXTURE_DIR}/database.sql"; then
  echo "the dump contains key material; refusing to write the fixture" >&2
  rm -f "${FIXTURE_DIR}/database.sql"
  exit 1
fi

echo "==> writing the manifest"
FIXTURE_DIR="${FIXTURE_DIR}" \
STAGE0_COMMIT="${STAGE0_COMMIT}" \
CAPTURE_COMMIT="$(git -C "${REPO}" rev-parse HEAD)" \
CAPTURE_TREE_CLEAN="$(git -C "${REPO}" diff --quiet HEAD -- apps packages services && echo true || echo false)" \
POSTGRES_IMAGE="${POSTGRES_IMAGE}" \
python3 "${FIXTURE_DIR}/manifest.py"

rm -f "${FIXTURE_DIR}/.summary.json"

echo "==> fixture written"
du -sh "${FIXTURE_DIR}" | sed 's/^/    /'
