#!/usr/bin/env bash
#
# Runs the user-interface and accessibility suite inside a container that has
# Chromium and its system libraries.
#
# The repository's only such image is the browser worker's, so the suite reuses
# it rather than introducing a second Chromium to keep in step. The controls
# are the same ones `deploy/compose/compose.yaml` applies to the worker, for
# the same reason `run-browser-tests.sh` gives: a green run should describe the
# shipped posture rather than a developer's machine.
#
# The suite drives the built bundle, so the bundle is built first. That also
# means `pnpm build`'s self-contained check has already run before any browser
# opens the page.
#
# Usage: pnpm --filter @reviewplane/web run test:ui:container

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"
image="reviewplane/browser-worker-test:local"

echo "==> building the web bundle"
(cd "${repo}" && pnpm --filter @reviewplane/web run build)

echo "==> building ${image}"
docker build \
  --file "${repo}/apps/browser-worker/Dockerfile" \
  --target browser-base \
  --tag "${image}" \
  "${repo}"

echo "==> running the user-interface suite"
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
  --workdir /work/apps/web \
  "${image}" \
  node --conditions=development --test --test-concurrency=1 "test/ui/*.test.ts"
