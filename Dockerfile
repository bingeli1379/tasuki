# The engine with the board, the built-in plugins, and the claude and codex CLIs for the agents.
# The instance's config is mounted at /instance, its state lives in the /data volume; see
# docker/compose.yaml.

FROM node:24.22.0-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
# The workspace's prepare script installs git hooks, which a build context has no repo for.
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm build \
  && node scripts/pack-cli.ts /opt/tasuki \
  && rm -rf /opt/tasuki/tarballs

FROM node:24.22.0-bookworm-slim
# Agents clone, branch and push in their workspaces.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.323 @openai/codex@0.169.0 \
  && npm cache clean --force
COPY --from=build /opt/tasuki /opt/tasuki
RUN ln -s /opt/tasuki/node_modules/.bin/tasuki /usr/local/bin/tasuki \
  && mkdir -p /data /instance \
  && chown node:node /data
USER node
WORKDIR /instance
VOLUME /data
EXPOSE 8787
CMD ["tasuki", "start", "--config", "/instance/tasuki.config.jsonc"]
