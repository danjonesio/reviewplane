# ReviewPlane tunnel gateway.
#
# The gateway is the only component that publishes a host port
# (deploy/compose/README.md), and it terminates connector data channels over
# mutual TLS. Being the most exposed component is why the runtime stage holds a
# static binary and nothing else: no shell, no package manager, no interpreter,
# so a request-handling flaw has nothing local to escalate into
# (docs/SECURITY.md section 9).
#
# The build context is the repository root, not this directory: the module
# resolves packages/protocol through the workspace file rather than a tag
# (go.work, ADR-0013).
#
# Base images are pinned by tag here; release builds pin by digest
# (docs/SECURITY.md section 19).

# ---------------------------------------------------------------------------
# builder: Go workspace build.
# ---------------------------------------------------------------------------
FROM golang:1.26-bookworm AS builder

WORKDIR /src

# go.work names three module directories and Go refuses to load a workspace
# whose members are missing, so services/connector is copied even though this
# image does not ship it. Trimming the workspace to build one member would mean
# maintaining a second copy of go.work, and a build that resolved
# packages/protocol differently from a developer's tree is worse than a wasted
# layer.
COPY go.work ./
COPY packages/protocol packages/protocol
COPY services/connector services/connector
COPY services/tunnel-gateway services/tunnel-gateway

# CGO_ENABLED=0 is what makes the binary runnable on a distroless base with no
# libc. -trimpath removes build-host paths from the binary, which is a
# prerequisite for the reproducible build of docs/SECURITY.md section 19;
# -s -w drop the symbol and DWARF tables.
#
# There is no version variable to stamp: unlike the connector, this module has
# no buildinfo package, so -ldflags -X has nothing to set. Adding one belongs
# with the release pipeline that would consume it.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
    -o /out/tunnel-gateway ./services/tunnel-gateway/cmd/tunnel-gateway

# A dedicated service user, built here because the runtime stage has no shell to
# create one in. UID 10001 matches apps/server and apps/browser-worker: the
# images share Compose volumes, and an artefact written by one is read by
# another only if they agree on the owner. The distroless base ships its own
# "nonroot" account at 65532, which these files deliberately replace so that
# every ReviewPlane image answers to the same identity.
RUN printf 'root:x:0:0:root:/:/sbin/nologin\nreviewplane:x:10001:10001::/nonexistent:/sbin/nologin\n' > /out/passwd \
    && printf 'root:x:0:\nreviewplane:x:10001:\n' > /out/group

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=builder /out/passwd /etc/passwd
COPY --from=builder /out/group /etc/group
COPY --from=builder /out/tunnel-gateway /usr/local/bin/tunnel-gateway

# The three listeners of services/tunnel-gateway/README.md. Only the proxy port
# is published to the host; the connector port is reachable from the development
# network and the admin port defaults to 127.0.0.1:8445, so it is unreachable
# from outside the container until an operator deliberately rebinds it. It is
# declared for documentation, not because the default makes it usable.
EXPOSE 8443 8444 8445

# No ENV defaults are set. internal/config already defaults the proxy and
# connector listeners to 0.0.0.0 and the admin listener to loopback, which are
# the values a container wants; repeating them here would create two places for
# them to drift apart.

USER 10001:10001

# Exec form and an absolute path: there is no shell in this image to resolve
# either. ENTRYPOINT rather than CMD so that "docker run <image> ..." passes
# arguments to the gateway instead of replacing it.
ENTRYPOINT ["/usr/local/bin/tunnel-gateway"]
