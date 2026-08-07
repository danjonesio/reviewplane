#!/bin/sh
# Entry point for the containerised development-environment fixture.
#
# It checks the checkout, starts the loopback applications, waits for them to
# answer, enrols the connector and then hands the process over to the
# connector's channel. The order matters: `docs/CONNECTOR_PROTOCOL.md` section
# 11 gives route publication a bounded startup grace on the destination port,
# and publishing before the application listens ends that grace with
# `PORT_NOT_LISTENING` rather than an indefinite wait.
#
# The checkout comes first because it is the cheapest check and the one whose
# failure is otherwise silent: the connector reports nothing about a directory
# that is not a Git work tree, so a broken workspace surfaces as an absence
# minutes later rather than as an error here.
#
# Every failure here exits non-zero with an explanation on stderr. A fixture
# that failed quietly would leave the end-to-end scenario waiting for a route
# that is never going to appear, and a timeout somewhere else reports the wrong
# component.
#
# Configuration comes from the environment `deploy/compose/compose.yaml` sets on
# the `dev-fixture` service:
#
#   REVIEWPLANE_CONTROL_PLANE_URL       required
#   REVIEWPLANE_CONTROL_PLANE_CA_FILE   required in Compose; optional here
#   REVIEWPLANE_ENROLMENT_TOKEN_FILE    a mounted secret, or
#   REVIEWPLANE_ENROLMENT_TOKEN         the token itself
#   PORT, HOST                          where the static application binds
#   REVIEWPLANE_FIXTURE_VITE            optional, default "1"; "0" skips
#                                        starting the Vite dev server, for a
#                                        run that only needs the static app

set -eu

fail() {
	printf 'dev-fixture: %s\n' "$1" >&2
	exit 1
}

CONFIG_FILE=/etc/reviewplane-connector/config.yaml
DATA_DIR=/var/lib/reviewplane-connector
# The checkout this development machine holds, and the directory the static
# application is served from. It is the path `connector-config.yaml` names in
# its `workspaces` block; the two have to agree, and this script checks that it
# is a checkout before it starts anything, rather than leaving the connector to
# report `not_a_git_checkout` every interval into a log nobody is reading.
WORKSPACE_DIR=/opt/reviewplane/dev-fixture
FIXTURE_HOST=${HOST:-127.0.0.1}
FIXTURE_PORT=${PORT:-4321}
FIXTURE_ORIGIN="http://${FIXTURE_HOST}:${FIXTURE_PORT}"
READY_TIMEOUT_MS=${FIXTURE_READY_TIMEOUT_MS:-30000}
# The Vite dev server's own address is not configurable the way the static
# application's is: it is hard-coded in vite.config.ts (`strictPort: true` on
# 5173), and this script has to agree with that file rather than parameterise
# around it.
FIXTURE_VITE_ENABLED=${REVIEWPLANE_FIXTURE_VITE:-1}
FIXTURE_VITE_ORIGIN="http://127.0.0.1:5173"
VITE_READY_TIMEOUT_MS=${FIXTURE_VITE_READY_TIMEOUT_MS:-30000}

[ -r "$CONFIG_FILE" ] ||
	fail "$CONFIG_FILE is not mounted or is not readable. The connector needs its configuration file to know which projects, workspaces and destinations it may publish; without it every route.publish is refused."
[ -n "${REVIEWPLANE_CONTROL_PLANE_URL:-}" ] ||
	fail "REVIEWPLANE_CONTROL_PLANE_URL is not set."
[ -w "$DATA_DIR" ] ||
	fail "$DATA_DIR is not writable by uid $(id -u). The connector writes its device key there and cannot enrol without it; in Compose this directory is a tmpfs and needs uid=10001,gid=10001,mode=0700."

# The workspace is checked before anything starts, because the alternative is a
# silent one. A connector whose configured workspace is not a checkout reports
# no observation at all (`docs/CONNECTOR_PROTOCOL.md` §9) and logs it at debug,
# so the end-to-end scenario would wait out its observation timeout with nothing
# to point at. Failing here names the directory and the reason instead.
#
# Two separate facts, because they fail for different reasons: that the
# directory is a work tree at all, and that it has a commit on HEAD. A
# repository initialised but never committed to has a branch and no head commit,
# which yields no observation either.
command -v git >/dev/null 2>&1 ||
	fail "no git executable is on PATH. The connector derives this machine's branch, head commit and dirty state by running git, and reports nothing about the workspace without it."
git -C "$WORKSPACE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
	fail "$WORKSPACE_DIR is not a Git work tree. The connector observes exactly the paths configured in $CONFIG_FILE and reports no context for a directory that is not a checkout, so the workspace would never appear in the control plane."
git -C "$WORKSPACE_DIR" rev-parse --verify --quiet HEAD >/dev/null 2>&1 ||
	fail "$WORKSPACE_DIR has no commit on HEAD. There is no head commit the connector protocol would accept, so the checkout yields no observation."
printf 'dev-fixture: workspace %s is a checkout on branch %s\n' \
	"$WORKSPACE_DIR" "$(git -C "$WORKSPACE_DIR" rev-parse --abbrev-ref HEAD)" >&2

# Flags shared by both connector invocations. Paths are passed explicitly rather
# than left to the binary's defaults so that the container's layout is visible
# in the process table and in these logs, not only in internal/config.
set -- --config "$CONFIG_FILE" --data-dir "$DATA_DIR"

# The CA flag is passed only when the variable is set, because an empty
# --ca-file is not the same as an absent one: it would mean "trust nothing
# extra" rather than "use the system trust store". Readability is checked here
# because the failure otherwise surfaces three enrolment attempts later as
# CONTROL_PLANE_UNAVAILABLE, which points at the wrong component.
if [ -n "${REVIEWPLANE_CONTROL_PLANE_CA_FILE:-}" ]; then
	[ -r "$REVIEWPLANE_CONTROL_PLANE_CA_FILE" ] ||
		fail "REVIEWPLANE_CONTROL_PLANE_CA_FILE names $REVIEWPLANE_CONTROL_PLANE_CA_FILE, which this container cannot read as uid $(id -u). Check that the file exists and that its mode allows the service user to read it."
	set -- "$@" --ca-file "$REVIEWPLANE_CONTROL_PLANE_CA_FILE"
fi

printf 'dev-fixture: starting the static application on %s\n' "$FIXTURE_ORIGIN" >&2
node "$WORKSPACE_DIR/static-app/src/main.ts" &
APP_PID=$!

# One Node process polls until the application answers, rather than a shell loop
# spawning an interpreter per attempt. The application's own bind guard refuses
# anything but a literal loopback address, so reaching it here over 127.0.0.1 is
# also a check that it bound where the evidence claims.
#
# The probe is written as an async function rather than with top-level await:
# `node -e` evaluates its argument as CommonJS, where top-level await is a
# syntax error.
#
# The ${...} below are JavaScript template literals and must reach Node
# unexpanded, so the probe is single-quoted and takes its two values from the
# environment instead.
# shellcheck disable=SC2016
FIXTURE_ORIGIN="$FIXTURE_ORIGIN" READY_TIMEOUT_MS="$READY_TIMEOUT_MS" node -e '
const origin = process.env.FIXTURE_ORIGIN;
const deadline = Date.now() + Number(process.env.READY_TIMEOUT_MS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForReady = async () => {
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(lastError);
};

waitForReady().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  },
);
' || fail "the static application did not answer GET ${FIXTURE_ORIGIN}/healthz within ${READY_TIMEOUT_MS}ms."

kill -0 "$APP_PID" 2>/dev/null || fail "the static application exited during startup."
printf 'dev-fixture: the static application is ready\n' >&2

# The Vite dev server, RVP-14's half of the fixture. It starts before
# enrolment for the same reason the static application does: a route MUST NOT
# be published before its destination is listening
# (docs/CONNECTOR_PROTOCOL.md section 11).
#
# `node .../vite/bin/vite.js` rather than a `vite` binary on PATH: this image
# installs the dependency tree but never symlinks a global binary, and
# resolving the CLI's own path from the package it was installed into is more
# robust than assuming one. The working directory is set by the subshell's
# `cd`, not by an absolute `--root`, because vite.config.ts's two-entry-point
# build (`index.html`, `products.html`) and its dev-server file watch are
# both resolved against the process's current directory. No `--host`: that
# flag is Vite's spelling of `0.0.0.0` and vite.config.ts already binds
# 127.0.0.1 — passing it here would silently override the file and defeat the
# loopback-only property this fixture exists to prove.
#
# `--configLoader native`: this container's root filesystem is read-only
# (`deploy/compose/compose.yaml`, `docs/SECURITY.md` section 10). Vite's
# default config loader bundles vite.config.ts and writes the bundled output
# to a temp file under node_modules/.vite-temp — a location `cacheDir` does
# not cover, so it would fail there with the filesystem read-only. The native
# loader instead imports the config file directly, relying on Node's own
# TypeScript support (`tsconfig.json`'s `erasableSyntaxOnly` keeps this
# config within what Node can strip) rather than writing anything to disk to
# load it.
if [ "$FIXTURE_VITE_ENABLED" != "0" ]; then
	printf 'dev-fixture: starting the Vite dev server on %s\n' "$FIXTURE_VITE_ORIGIN" >&2
	(cd /app/vite-app && exec node node_modules/vite/bin/vite.js --config vite.config.ts --configLoader native) &
	VITE_PID=$!

	# Same probe shape as the static application's above: one bounded Node
	# process rather than a shell polling loop, so a cold-start failure is
	# reported here and named as Vite's, not surfaced three steps later as
	# PORT_NOT_LISTENING against the wrong component.
	# shellcheck disable=SC2016
	FIXTURE_VITE_ORIGIN="$FIXTURE_VITE_ORIGIN" READY_TIMEOUT_MS="$VITE_READY_TIMEOUT_MS" node -e '
const origin = process.env.FIXTURE_VITE_ORIGIN;
const deadline = Date.now() + Number(process.env.READY_TIMEOUT_MS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForReady = async () => {
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(lastError);
};

waitForReady().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  },
);
' || fail "the Vite dev server did not answer GET ${FIXTURE_VITE_ORIGIN}/ within ${VITE_READY_TIMEOUT_MS}ms."

	kill -0 "$VITE_PID" 2>/dev/null || fail "the Vite dev server exited during startup."
	printf 'dev-fixture: the Vite dev server is ready\n' >&2
else
	printf 'dev-fixture: REVIEWPLANE_FIXTURE_VITE=0, not starting the Vite dev server\n' >&2
fi

# Enrolment is once per identity. In Compose the data directory is a tmpfs, so
# every run starts empty and enrols with a fresh single-use token; on a plain
# `docker run` with a persistent volume an existing record is reused, because
# re-enrolling would need --force and would discard a working device identity.
if [ -f "$DATA_DIR/identity.json" ]; then
	printf 'dev-fixture: reusing the existing device identity in %s\n' "$DATA_DIR" >&2
else
	# The connector accepts the token from --token, --token-file or
	# REVIEWPLANE_ENROLMENT_TOKEN and refuses more than one, so exactly one form
	# is selected here. A file is preferred: it keeps the credential out of the
	# process table and out of the environment (docs/SECURITY.md section 18),
	# and it is how Compose delivers a secret.
	if [ -n "${REVIEWPLANE_ENROLMENT_TOKEN_FILE:-}" ]; then
		[ -r "$REVIEWPLANE_ENROLMENT_TOKEN_FILE" ] ||
			fail "REVIEWPLANE_ENROLMENT_TOKEN_FILE names $REVIEWPLANE_ENROLMENT_TOKEN_FILE, which this container cannot read as uid $(id -u). A secret written mode 0600 and owned by the host user is not readable by the service user."
		[ -s "$REVIEWPLANE_ENROLMENT_TOKEN_FILE" ] ||
			fail "$REVIEWPLANE_ENROLMENT_TOKEN_FILE is empty. The end-to-end script issues the enrolment token into it before starting this service."
		[ -z "${REVIEWPLANE_ENROLMENT_TOKEN:-}" ] ||
			fail "both REVIEWPLANE_ENROLMENT_TOKEN_FILE and REVIEWPLANE_ENROLMENT_TOKEN are set. Supply the enrolment token exactly once."
		set -- "$@" --token-file "$REVIEWPLANE_ENROLMENT_TOKEN_FILE"
	elif [ -z "${REVIEWPLANE_ENROLMENT_TOKEN:-}" ]; then
		fail "no enrolment token: set REVIEWPLANE_ENROLMENT_TOKEN_FILE or REVIEWPLANE_ENROLMENT_TOKEN. $DATA_DIR holds no identity, so there is nothing to enrol with."
	fi
	# When only REVIEWPLANE_ENROLMENT_TOKEN is set it is left in the
	# environment: the connector reads that variable itself, and adding a flag
	# would be the second form it refuses.

	printf 'dev-fixture: enrolling with %s\n' "$REVIEWPLANE_CONTROL_PLANE_URL" >&2
	reviewplane-connector enrol --control-plane "$REVIEWPLANE_CONTROL_PLANE_URL" "$@" ||
		fail "enrolment failed with exit status $?. Exit 3 is a refusal an operator must act on, such as an invalid or already-used token; exit 1 may resolve on a retry."

	# --token-file was appended for enrolment only; `run` does not accept it.
	set -- --config "$CONFIG_FILE" --data-dir "$DATA_DIR"
	if [ -n "${REVIEWPLANE_CONTROL_PLANE_CA_FILE:-}" ]; then
		set -- "$@" --ca-file "$REVIEWPLANE_CONTROL_PLANE_CA_FILE"
	fi
fi

# exec, so the connector becomes PID 1 and receives SIGTERM directly. The
# static application and the Vite dev server, when running, stay children of
# PID 1 and go down with the container; this is a fixture, and a supervisor
# that restarted part of it would hide exactly the failure the scenario is
# meant to surface.
printf 'dev-fixture: starting the connector channel\n' >&2
exec reviewplane-connector run "$@"
