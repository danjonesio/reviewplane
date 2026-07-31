#!/usr/bin/env bash
#
# The end-to-end scenario's configuration step.
#
# There is exactly one generator of this stack's secrets and TLS material, and
# it is `deploy/compose/configure` — the script an operator runs. A second copy
# here would be a second thing to keep in step with `compose.yaml`, and the
# copy that only tests run is the one that would drift; the end-to-end scenario
# would then be proving a configuration nobody installs.
#
# So this script runs `configure` and adds the two things a scenario needs that
# an installation does not: the `development` profile's connector configuration,
# and the images built from the checkout rather than pulled from a registry.
#
# It is idempotent, because regenerating the capability signing key while the
# stack is running would invalidate every capability the control plane has
# already minted and regenerating the gateway certificate would invalidate the
# pin the browser worker was started with (ADR-0015). Pass --force to replace
# everything.

set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARGS=(--development --image-source build)
[[ "${1:-}" == "--force" ]] && ARGS+=(--force)

exec "${COMPOSE_DIR}/configure" "${ARGS[@]}"
