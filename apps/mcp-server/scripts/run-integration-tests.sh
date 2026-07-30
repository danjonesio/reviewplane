#!/usr/bin/env bash
#
# Runs steps 9 to 12 of the primary end-to-end scenario (`docs/TESTING.md`
# section 3) against real components.
#
# The suite needs Chromium and its system libraries, which a developer
# workstation may not have, and it needs the Chromium sandbox enabled, which
# `docs/SECURITY.md` section 10 requires. It runs in the browser worker's own
# image under the same container controls `deploy/compose/compose.yaml` applies:
#
#   * non-root service user
#   * all capabilities dropped except SYS_CHROOT, which Chromium's own sandbox
#     needs to chroot itself inside its new user namespace
#   * no new privileges
#   * `deploy/compose/browser-worker-seccomp.json`
#   * an **internal** Docker network, so the only thing reachable is the
#     PostgreSQL container beside it: the fixture application and every service
#     under test are on the container's own loopback, and nothing can reach the
#     internet. The browser suite uses `--network none` for the same reason;
#     this one needs a database, and an internal network is the narrowest thing
#     that provides one.
#
# Every name is unique per run, so two of these can run at once and a failed run
# leaves nothing behind for the next one to trip over.
#
# Usage: pnpm --filter @reviewplane/mcp-server run test:integration

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"
image="reviewplane/browser-worker-test:local"
run_id="rvp39-$(date +%s)-$$"
network="${run_id}-net"
postgres="${run_id}-postgres"
postgres_password="reviewplane-integration"

cleanup() {
  docker rm --force "${postgres}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building ${image}"
docker build \
  --file "${repo}/apps/browser-worker/Dockerfile" \
  --target browser-base \
  --tag "${image}" \
  "${repo}"

echo "==> creating the internal network ${network}"
docker network create --internal "${network}" >/dev/null

echo "==> starting PostgreSQL"
docker run --detach \
  --name "${postgres}" \
  --network "${network}" \
  --env "POSTGRES_PASSWORD=${postgres_password}" \
  postgres:17-alpine >/dev/null

echo "==> waiting for PostgreSQL"
for _ in $(seq 1 60); do
  if docker exec "${postgres}" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> running steps 9 to 12 under the deployed container controls"
docker run --rm \
  --network "${network}" \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --security-opt no-new-privileges \
  --security-opt "seccomp=${repo}/deploy/compose/browser-worker-seccomp.json" \
  --shm-size 1g \
  --env HOME=/tmp \
  --env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  --env "REVIEWPLANE_TEST_DATABASE_URL=postgres://postgres:${postgres_password}@${postgres}:5432/postgres" \
  --volume "${repo}:/work" \
  --workdir /work/apps/mcp-server \
  "${image}" \
  node --conditions=development --test --test-concurrency=1 \
    "test/integration/**/*.test.ts"
