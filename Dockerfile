FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git util-linux ffmpeg docker.io docker-compose && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY package.json ./
COPY docker/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
FROM dependencies AS test
RUN pnpm verify
FROM dependencies AS runtime
# Keep this pin aligned with TASK_CODEX_VERSION. Isolated agents run this CLI
# in the relay; do not bind-mount the operator's ~/.codex.
ARG CODEX_CLI_VERSION=0.153.4
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION} && command -v codex
RUN chmod +x docker/entrypoint.sh bin/ez bin/ezenciel-agents* && mkdir -p /state/control /state/home /workspace && chown node:node /state/control /state/home /workspace
RUN node -e 'for (const [name, target] of Object.entries(require("./package.json").bin)) require("node:fs").symlinkSync("/app/" + target, "/usr/local/bin/" + name); require("node:fs").symlinkSync("/app/bin/ez", "/usr/local/bin/ez")'
ENV HOME=/state/home EZ_AGENT_WORKSPACE=/workspace EZ_CONTROL_DIR=/state/control EZ_EXECUTOR_CLI=grok PATH=/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["start"]
