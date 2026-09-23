FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git util-linux ffmpeg docker.io docker-compose && rm -rf /var/lib/apt/lists/*
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
# Isolated agents run the selected CLI in the relay; host-capable agents reuse
# the host installation instead. OpenCode carries no task-runner pin because
# restricted messaging tasks stay on the audited Codex above.
ARG OPENCODE_CLI_VERSION=1.18.29
RUN npm install -g opencode-ai@${OPENCODE_CLI_VERSION} && command -v opencode && opencode --version
# Isolated agents select pi from the relay menu; the binary must resolve on
# the relay PATH just like codex/opencode above.
ARG PI_CLI_VERSION=0.87.1
RUN npm install -g @earendil-works/pi-coding-agent@${PI_CLI_VERSION} && command -v pi
# Isolated agents select unreal-agent from the relay menu; fetch the pinned
# upstream linux binary (verified against the release SHA256SUMS).
ARG UNREAL_AGENT_VERSION=0.1.1
RUN set -eu; arch="$(dpkg --print-architecture)"; \
  curl -fsSL -o /tmp/unreal-agent-runner.tar.gz "https://github.com/unreallabsai/unreal-agent/releases/download/v${UNREAL_AGENT_VERSION}/unreal-agent-runner_${UNREAL_AGENT_VERSION}_linux_${arch}.tar.gz"; \
  curl -fsSL -o /tmp/SHA256SUMS "https://github.com/unreallabsai/unreal-agent/releases/download/v${UNREAL_AGENT_VERSION}/SHA256SUMS"; \
  (cd /tmp && ln -sf unreal-agent-runner.tar.gz "unreal-agent-runner_${UNREAL_AGENT_VERSION}_linux_${arch}.tar.gz" && sha256sum -c SHA256SUMS --ignore-missing); \
  tar -xzf /tmp/unreal-agent-runner.tar.gz -C /usr/local/bin unreal-agent-runner; \
  chmod +x /usr/local/bin/unreal-agent-runner; command -v unreal-agent-runner; \
  rm -f /tmp/unreal-agent-runner.tar.gz /tmp/SHA256SUMS "/tmp/unreal-agent-runner_${UNREAL_AGENT_VERSION}_linux_${arch}.tar.gz"
RUN chmod +x docker/entrypoint.sh bin/ez bin/ezenciel-agents* && mkdir -p /state/control /state/home /workspace && chown node:node /state/control /state/home /workspace
RUN node -e 'for (const [name, target] of Object.entries(require("./package.json").bin)) require("node:fs").symlinkSync("/app/" + target, "/usr/local/bin/" + name); require("node:fs").symlinkSync("/app/bin/ez", "/usr/local/bin/ez")'
# Build identity for relay status (package version stays release-owned).
ARG BUILD_TAG=""
ARG BUILD_SHA=""
RUN node -e 'require("node:fs").writeFileSync("/app/build.json",JSON.stringify({tag:process.env.BUILD_TAG||"",sha:process.env.BUILD_SHA||""})+"\n")'
ENV HOME=/state/home EZ_AGENT_WORKSPACE=/workspace EZ_CONTROL_DIR=/state/control EZ_EXECUTOR_CLI=grok PATH=/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /workspace
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["start"]
