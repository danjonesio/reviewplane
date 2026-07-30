# ReviewPlane browser worker.
#
# The worker is the only component that executes untrusted page content
# (docs/SECURITY.md section 3), so the isolation posture in section 10 is part
# of the image rather than something the operator adds later:
#
#   * dedicated non-root service user
#   * Chromium sandbox left enabled (no --no-sandbox anywhere)
#   * no Docker socket, no host network (enforced by deploy/compose)
#   * read-only root filesystem, with writable tmpfs mounts for the per-session
#     profile directories only
#
# Base images are pinned by tag here; release builds pin by digest
# (docs/SECURITY.md section 19).

# ---------------------------------------------------------------------------
# browser-base: Node plus Chromium and its system libraries.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS browser-base

# Browsers live outside the service user's home so the root filesystem can stay
# read-only at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# `--with-deps` installs the Chromium system libraries. It is a build-time step
# performed as root; nothing in the runtime stage needs elevated privileges.
RUN npx --yes playwright@1.62.0 install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && chmod -R a+rX /opt/ms-playwright

# ---------------------------------------------------------------------------
# builder: workspace install and TypeScript build.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /src
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/browser-worker/package.json apps/browser-worker/
RUN pnpm install --frozen-lockfile --filter @reviewplane/browser-worker...

COPY packages/protocol packages/protocol
COPY apps/browser-worker apps/browser-worker
RUN pnpm --filter @reviewplane/protocol run build \
    && pnpm --filter @reviewplane/browser-worker run build \
    && pnpm deploy --filter @reviewplane/browser-worker --prod --legacy /app

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM browser-base AS runtime

# A dedicated service user (docs/SECURITY.md section 10). The high UID keeps it
# clear of host users when the container runs with a user namespace.
RUN groupadd --system --gid 10001 reviewplane \
    && useradd --system --uid 10001 --gid 10001 --home-dir /home/reviewplane \
       --create-home --shell /usr/sbin/nologin reviewplane

WORKDIR /app
COPY --from=builder --chown=root:root /app /app

# Per-session profile directories are created here. deploy/compose mounts a
# tmpfs so the root filesystem itself stays read-only.
RUN mkdir -p /var/lib/reviewplane/browser-sessions \
    && chown reviewplane:reviewplane /var/lib/reviewplane/browser-sessions

ENV NODE_ENV=production \
    REVIEWPLANE_WORKER_SESSION_ROOT=/var/lib/reviewplane/browser-sessions \
    REVIEWPLANE_WORKER_LISTEN_ADDRESS=0.0.0.0 \
    REVIEWPLANE_WORKER_PORT=8090

USER reviewplane:reviewplane
EXPOSE 8090

# No port is published to the host: deploy/compose keeps the worker on an
# internal network reachable only by the control-plane server.
CMD ["node", "dist/main.js"]
