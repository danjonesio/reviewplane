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

HEALTHCHECK --interval=15s --timeout=5s --retries=4 \
    CMD wget --quiet --spider --no-check-certificate https://127.0.0.1:8443/healthz || exit 1
