# ReviewPlane control-plane server.
#
# The server never runs a browser and never gets the Docker socket
# (AGENTS.md "Mandatory engineering rules"). It is the only component holding
# artefact-store access, which is why the browser worker uploads through it
# rather than to storage directly (ADR-0012).

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @reviewplane/server...

COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm --filter @reviewplane/protocol run build \
    && pnpm --filter @reviewplane/server run build \
    && pnpm deploy --filter @reviewplane/server --prod --legacy /app

FROM node:24-bookworm-slim AS runtime

RUN groupadd --system --gid 10001 reviewplane \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/reviewplane \
       --create-home --shell /usr/sbin/nologin reviewplane

WORKDIR /app
COPY --from=builder --chown=root:root /app /app
# Migrations are read at startup and are not part of the compiled output.
COPY --from=builder --chown=root:root /src/apps/server/migrations /app/migrations

RUN mkdir -p /var/lib/reviewplane/artefacts \
    && chown reviewplane:reviewplane /var/lib/reviewplane/artefacts

ENV NODE_ENV=production \
    REVIEWPLANE_ARTEFACT_PATH=/var/lib/reviewplane/artefacts \
    REVIEWPLANE_LISTEN_ADDRESS=0.0.0.0 \
    REVIEWPLANE_PORT=8080

USER reviewplane:reviewplane
EXPOSE 8080

CMD ["node", "dist/main.js"]
