# ReviewPlane gateway (`docs/ARCHITECTURE.md` section 4.1).
#
# The gateway is the only component that publishes a host port. It terminates
# TLS, serves the web application's static assets, upgrades WebSockets and
# applies security headers and request-size limits. It holds no credentials, no
# database access and no Docker socket: it is a router with a document root.
#
# The web application is built here rather than shipped as a separate service
# because ADR-0011 removed the server-rendering process — the build output is
# static files, and the component that serves static files is this one.

FROM node:24-bookworm-slim AS web

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @reviewplane/web...

COPY packages/protocol packages/protocol
COPY apps/web apps/web
# `pnpm build` in apps/web runs the self-contained check, so an image cannot be
# produced from a bundle that would reach an external host (ADR-0011).
RUN pnpm --filter @reviewplane/web run build

FROM caddy:2-alpine AS runtime

COPY --from=web /src/apps/web/dist /srv/web
COPY deploy/compose/gateway/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8443

ENV REVIEWPLANE_GATEWAY_DOMAIN=localhost

# The probe presents the site's name in SNI and resolves it to loopback.
#
# Both halves are load-bearing. A named site has no certificate for any other
# name, and Caddy does not fall back to the one it holds: a probe that dialled
# `https://127.0.0.1:8443` would be answered with a TLS internal-error alert and
# would report a healthy gateway as unhealthy. A Host header alone does not fix
# it, because the handshake fails before a header is sent. `--resolve` is why
# this works for a real domain too, which does not resolve inside the container.
#
# --insecure: the internal authority is not in this image's trust store, and
# what the probe is asserting is that the gateway answers, not who signed it.
HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
    CMD curl --fail --silent --insecure --max-time 4 \
        --resolve "${REVIEWPLANE_GATEWAY_DOMAIN}:8443:127.0.0.1" \
        "https://${REVIEWPLANE_GATEWAY_DOMAIN}:8443/healthz" || exit 1
