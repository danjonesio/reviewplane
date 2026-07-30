# The development-environment fixture, containerised.
#
# This image stands in for "the agent's development VM" in the locked product
# loop: it holds the loopback application *and* the connector that publishes it,
# because those two have to share a network namespace. The connector reaches a
# development service by dialling loopback from the same machine
# (docs/CONNECTOR_PROTOCOL.md section 11), so splitting them into two containers
# would need the service to listen on a container-external address — which is
# precisely the property the fixture exists to disprove the need for.
#
# **This image opens no inbound port.** There is no EXPOSE below and the
# deployment publishes nothing: the application binds 127.0.0.1 inside the
# container's own namespace, and the only sockets leaving it are the connector's
# outbound ones. That is Stage 0 exit criterion 5, and `ss -ltnp` run inside a
# running container is the evidence for it.
#
# Only the static application is here. The Vite application in this directory
# has npm dependencies, and installing them would put a package tree in the
# image that the end-to-end scenario never exercises; the scenario publishes the
# static application.
#
# The build context is the repository root, because the connector is built from
# source in the same workspace the rest of the repository uses. Building with
# the root `.dockerignore` would exclude `examples/`, so this Dockerfile carries
# its own `Dockerfile.dockerignore`, which BuildKit prefers when it exists.
#
# Base images are pinned by tag here; release builds pin by digest
# (docs/SECURITY.md section 19).

# ---------------------------------------------------------------------------
# connector-builder: the same build as services/connector/Dockerfile.
#
# It is repeated rather than shared because a Dockerfile cannot import a stage
# from another file, and making this image depend on a pre-built connector tag
# would make the end-to-end scenario depend on build ordering. If the connector
# build changes, services/connector/Dockerfile is the authoritative copy and
# this one follows it.
# ---------------------------------------------------------------------------
FROM golang:1.26-bookworm AS connector-builder

WORKDIR /src
COPY go.work ./
COPY packages/protocol packages/protocol
COPY services/connector services/connector
COPY services/tunnel-gateway services/tunnel-gateway

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/reviewplane-connector ./services/connector/cmd/reviewplane-connector

# ---------------------------------------------------------------------------
# runtime
#
# Node 24 matches apps/server and apps/browser-worker and the root package.json
# engines field. The static application has no dependencies and no build step:
# Node runs its TypeScript sources directly, so there is no install stage.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# iproute2 is here for evidence collection only, not for anything the fixture
# needs to run: RVP-11 requires `ss -ltnp` captured *during* a successful load,
# and the listener that has to be shown as loopback-only lives in this
# container's network namespace, so the command has to run in here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*

# A dedicated service user at the UID every other ReviewPlane image uses. The
# base image's own `node` user at 1000 is deliberately not reused: the fixture
# shares the connector's identity volume, and the connector refuses a private
# key owned by a different account.
RUN groupadd --system --gid 10001 reviewplane \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/reviewplane \
       --create-home --shell /usr/sbin/nologin reviewplane

COPY --from=connector-builder /out/reviewplane-connector /usr/local/bin/reviewplane-connector
COPY examples/dev-fixture/static-app /app/static-app
COPY --chmod=0755 examples/dev-fixture/entrypoint.sh /usr/local/bin/entrypoint.sh

# The identity data directory of docs/CONNECTOR_PROTOCOL.md section 20, created
# here because /var/lib is root-owned and the service user could not create it.
# 0700 is identity.DataDirMode; the connector re-asserts it on every start and
# writes device.key at 0600, then refuses to start if either has been widened.
RUN mkdir -p /var/lib/reviewplane-connector \
    && chown reviewplane:reviewplane /var/lib/reviewplane-connector \
    && chmod 0700 /var/lib/reviewplane-connector

# Stated rather than left to the application's defaults, so that the bind
# address is visible in `docker inspect` and not only in the source. The
# application refuses any address that is not literal loopback, so overriding
# HOST to reach it from outside the container fails by design rather than
# quietly publishing it.
ENV HOST=127.0.0.1 \
    PORT=4321

USER reviewplane:reviewplane

# No EXPOSE, deliberately. See the header: this container opens no inbound port,
# and a port declaration would suggest otherwise to anyone reading the image.

# `docker compose up --wait` blocks on this, so it has to mean "the development
# environment is fully up", not "a process is running". Both halves are checked:
# the application answering /healthz, and the connector having written its
# device identity. Either one alone would report ready while the scenario's next
# step — publishing a route — still could not succeed.
#
# In Compose the data directory is a tmpfs, so identity.json appears once per
# container start, which is correct: each run enrols with a fresh single-use
# token. The start period covers the control plane coming up and the enrolment
# round trip; the retries then cover a slow one without waiting on a dead one.
HEALTHCHECK --interval=5s --timeout=10s --start-period=90s --retries=6 \
    CMD test -f /var/lib/reviewplane-connector/identity.json \
        && node -e 'const port = process.env.PORT || 4321; fetch("http://127.0.0.1:" + port + "/healthz").then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1));'

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
