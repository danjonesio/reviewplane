#!/bin/sh
# Entry point for the containerised development-environment fixture.
#
# It starts the loopback application, waits for it to answer, enrols the
# connector and then hands the process over to the connector's channel. The
# order matters: `docs/CONNECTOR_PROTOCOL.md` section 11 gives route publication
# a bounded startup grace on the destination port, and publishing before the
# application listens ends that grace with `PORT_NOT_LISTENING` rather than an
# indefinite wait.
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

set -eu

fail() {
	printf 'dev-fixture: %s\n' "$1" >&2
	exit 1
}

CONFIG_FILE=/etc/reviewplane-connector/config.yaml
DATA_DIR=/var/lib/reviewplane-connector
FIXTURE_HOST=${HOST:-127.0.0.1}
FIXTURE_PORT=${PORT:-4321}
FIXTURE_ORIGIN="http://${FIXTURE_HOST}:${FIXTURE_PORT}"
READY_TIMEOUT_MS=${FIXTURE_READY_TIMEOUT_MS:-30000}

[ -r "$CONFIG_FILE" ] ||
	fail "$CONFIG_FILE is not mounted or is not readable. The connector needs its configuration file to know which projects, workspaces and destinations it may publish; without it every route.publish is refused."
[ -n "${REVIEWPLANE_CONTROL_PLANE_URL:-}" ] ||
	fail "REVIEWPLANE_CONTROL_PLANE_URL is not set."
[ -w "$DATA_DIR" ] ||
	fail "$DATA_DIR is not writable by uid $(id -u). The connector writes its device key there and cannot enrol without it; in Compose this directory is a tmpfs and needs uid=10001,gid=10001,mode=0700."

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
node /app/static-app/src/main.ts &
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

# exec, so the connector becomes PID 1 and receives SIGTERM directly. The static
# application stays a child of PID 1 and goes down with the container; this is a
# fixture, and a supervisor that restarted half of it would hide exactly the
# failure the scenario is meant to surface.
printf 'dev-fixture: starting the connector channel\n' >&2
exec reviewplane-connector run "$@"
