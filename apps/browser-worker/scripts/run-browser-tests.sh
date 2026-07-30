#!/usr/bin/env bash
#
# Runs the Chromium-backed browser suite inside the worker's own image.
#
# The suite needs Chromium and its system libraries, which a developer
# workstation may not have, and it needs the Chromium sandbox enabled, which
# `docs/SECURITY.md` section 10 requires. Running it in the shipped image under
# the same container controls `deploy/compose/compose.yaml` applies means the
# tests prove the deployed posture rather than a laxer local one:
#
#   * non-root service user
#   * all capabilities dropped except SYS_CHROOT, which Chromium's own sandbox
#     needs to chroot itself inside its new user namespace
#   * no new privileges
#   * `deploy/compose/browser-worker-seccomp.json`, which is Docker's default
#     profile plus user-namespace creation
#   * `--network none`, so only loopback works: the fixture application runs
#     inside the container and nothing can reach the internet
#   * no Docker socket
#
# Usage: pnpm --filter @reviewplane/browser-worker run test:browser:container

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"
image="reviewplane/browser-worker-test:local"

echo "==> building ${image}"
docker build \
  --file "${repo}/apps/browser-worker/Dockerfile" \
  --target browser-base \
  --tag "${image}" \
  "${repo}"

echo "==> running the browser suite under the deployed container controls"
exec docker run --rm \
  --network none \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --cap-add SYS_CHROOT \
  --security-opt no-new-privileges \
  --security-opt "seccomp=${repo}/deploy/compose/browser-worker-seccomp.json" \
  --shm-size 1g \
  --env HOME=/tmp \
  --env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
  --volume "${repo}:/work" \
  --workdir /work/apps/browser-worker \
  "${image}" \
  node --conditions=development --test --test-concurrency=1 "test/browser/**/*.test.ts"
