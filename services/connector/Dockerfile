# ReviewPlane connector — container build for the end-to-end Compose fixture.
#
# This image is a test fixture, not the supported way to run a connector. In a
# real deployment the connector is a statically linked binary installed on the
# developer's own VM or workstation (docs/DEPLOYMENT.md "Native connector
# packages", services/connector/README.md): it has to run where the development
# service is, and putting it in a container elsewhere would defeat the loopback
# dial that keeps the service off the network. The image exists so that the
# Compose end-to-end scenario can stand a development environment up
# reproducibly.
#
# The connector opens no listening socket, in a container as anywhere else, so
# this image declares no EXPOSE and needs no published port.
#
# The build context is the repository root: the module resolves
# packages/protocol and services/tunnel-gateway through the workspace file
# rather than a tag (go.work, ADR-0013).
#
# Base images are pinned by tag here; release builds pin by digest
# (docs/SECURITY.md section 19).

# ---------------------------------------------------------------------------
# builder: Go workspace build.
# ---------------------------------------------------------------------------
FROM golang:1.26-bookworm AS builder

WORKDIR /src

# All three workspace members are needed, and not only because go.work refuses
# to load without them: services/connector genuinely imports the destination
# policy and the stream multiplexer from services/tunnel-gateway, so that both
# ends of the data channel share one implementation rather than two that agree
# by inspection (services/connector/README.md "Route publication").
COPY go.work ./
COPY packages/protocol packages/protocol
COPY services/connector services/connector
COPY services/tunnel-gateway services/tunnel-gateway

# CGO_ENABLED=0 gives the statically linked binary
# docs/CONNECTOR_PROTOCOL.md section 3 requires, which is also what makes a
# distroless base viable. -trimpath removes build-host paths; -s -w drop the
# symbol and DWARF tables.
#
# internal/buildinfo declares Version as a const, so -ldflags -X cannot stamp
# it: the linker only rewrites string variables. Changing it to a var to make
# it stampable is a change to services/connector and belongs with the release
# pipeline that would supply the value, not with this image.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/reviewplane-connector ./services/connector/cmd/reviewplane-connector

# The service user, created here because the runtime stage has no shell. UID
# 10001 matches every other ReviewPlane image.
RUN printf 'root:x:0:0:root:/:/sbin/nologin\nreviewplane:x:10001:10001::/nonexistent:/sbin/nologin\n' > /out/passwd \
    && printf 'root:x:0:\nreviewplane:x:10001:\n' > /out/group

# The identity data directory of docs/CONNECTOR_PROTOCOL.md section 20. It is
# created here with its final owner and mode because the runtime stage cannot
# run mkdir, and because the connector cannot create it itself: /var/lib is
# root-owned, so a process running as 10001 would fail before it ever wrote a
# key. 0700 is identity.DataDirMode; the connector re-asserts it on every start
# and writes device.key at 0600, then refuses to start if either has been
# widened (services/connector/internal/identity).
RUN mkdir -p /out/data \
    && chown 10001:10001 /out/data \
    && chmod 0700 /out/data

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=builder /out/passwd /etc/passwd
COPY --from=builder /out/group /etc/group
COPY --from=builder /out/reviewplane-connector /usr/local/bin/reviewplane-connector

# --chown and --chmod are not decoration. When COPY's source is a directory,
# Docker copies its contents and creates the destination itself, so the
# directory's own owner and mode do not carry over from the builder stage: the
# same COPY without these flags produces root-owned drwxr-xr-x, and the
# connector then fails to write its key. Both flags need BuildKit, which is the
# default builder for Docker Engine 23 and later and for Compose v2.
COPY --from=builder --chown=10001:10001 --chmod=700 /out/data /var/lib/reviewplane-connector

# No EXPOSE. The connector connects outbound only and never listens; a port
# declaration here would misdescribe it (ADR-0002, docs/SECURITY.md section 9).

USER 10001:10001

# ENTRYPOINT so that the subcommand is an argument: "enrol" exchanges a one-time
# token for a device identity and "run" holds the channel open. Configuration is
# read from /etc/reviewplane-connector/config.yaml, which the deployment mounts.
ENTRYPOINT ["/usr/local/bin/reviewplane-connector"]
CMD ["run"]
