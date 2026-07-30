# ReviewPlane MCP server.
#
# `docs/ARCHITECTURE.md` section 4.4 permits the MCP server to share packages
# and a deployment image with the control-plane server, and requires it to be a
# separate process and route. This image takes the second half of that literally
# and the first half loosely: it is built the same way `apps/server`'s image is,
# from the same workspace, but it is its own image so the two processes can be
# scaled, restarted and read in logs independently.
#
# It never runs a browser and never gets the Docker socket. It holds no
# administrator credential: the agent-facing process has no use for one, and a
# process that cannot read one cannot leak one.

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/mcp-server/package.json apps/mcp-server/
RUN pnpm install --frozen-lockfile --filter @reviewplane/mcp-server...

COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY apps/mcp-server apps/mcp-server
RUN pnpm --filter @reviewplane/protocol run build \
    && pnpm --filter @reviewplane/server run build \
    && pnpm --filter @reviewplane/mcp-server run build \
    && pnpm deploy --filter @reviewplane/mcp-server --prod --legacy /app

FROM node:24-bookworm-slim AS runtime

RUN groupadd --system --gid 10001 reviewplane \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/reviewplane \
       --create-home --shell /usr/sbin/nologin reviewplane

WORKDIR /app
COPY --from=builder --chown=root:root /app /app

ENV NODE_ENV=production \
    REVIEWPLANE_ARTEFACT_PATH=/var/lib/reviewplane/artefacts \
    REVIEWPLANE_MCP_LISTEN_ADDRESS=0.0.0.0 \
    REVIEWPLANE_MCP_PORT=8081 \
    REVIEWPLANE_MCP_PATH=/mcp/v1

USER reviewplane:reviewplane
EXPOSE 8081

CMD ["node", "dist/main.js"]
