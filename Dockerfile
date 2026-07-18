FROM node:22.22.3-alpine@sha256:f0a08e0402831ac4097e9825704bc2dfe6d2c1333de99686a89ca649159b02c8 AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/kassalapp/package.json packages/kassalapp/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
ARG APP_COMMIT_SHA=development
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
RUN pnpm security:licenses
RUN pnpm --filter web build
RUN pnpm --filter @handleplan/worker build
RUN node scripts/e2e/public-build-binding.mjs verify
RUN set -eu; \
    rm -rf /app/.handleplan-runtime-stage /app/handleplan-runtime-shipment-binding.json; \
    install -d -m 0755 \
      /app/.handleplan-runtime-stage/apps/worker/dist \
      /app/.handleplan-runtime-stage/deploy/migrations \
      /app/.handleplan-runtime-stage/node_modules/postgres; \
    install -m 0644 /app/apps/worker/dist/main.mjs \
      /app/.handleplan-runtime-stage/apps/worker/dist/main.mjs; \
    install -m 0755 /app/deploy/entrypoint.sh \
      /app/.handleplan-runtime-stage/deploy/entrypoint.sh; \
    install -m 0644 /app/deploy/migrate.mjs \
      /app/.handleplan-runtime-stage/deploy/migrate.mjs; \
    cp -R /app/deploy/migrations/. \
      /app/.handleplan-runtime-stage/deploy/migrations/; \
    cp -R /app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/. \
      /app/.handleplan-runtime-stage/node_modules/postgres/; \
    node scripts/operations/verify-production-image.mjs seal-runtime \
      --runtime-root /app/.handleplan-runtime-stage \
      --output /app/handleplan-runtime-shipment-binding.json \
      --expected-revision "$APP_COMMIT_SHA" \
      --repository-root /app

FROM base AS runner
WORKDIR /app
ARG APP_COMMIT_SHA=development
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.revision="$APP_COMMIT_SHA" \
      org.opencontainers.image.source="https://github.com/Reedtrullz/Handli"

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs \
    && install -d -o nextjs -g nodejs -m 0700 /var/lib/handleplan/private-captures

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/handleplan-public-build-binding.json ./apps/web/.next/handleplan-public-build-binding.json
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone /app/.handleplan-release/standalone
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/BUILD_ID /app/.handleplan-release/build-root/BUILD_ID
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static /app/.handleplan-release/build-root/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/handleplan-public-build-environment.json /app/.handleplan-release/build-root/handleplan-public-build-environment.json
COPY --from=builder --chown=nextjs:nodejs /app/Dockerfile /app/.handleplan-release/packaging/Dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/.dockerignore /app/.handleplan-release/packaging/.dockerignore
COPY --from=builder --chown=nextjs:nodejs /app/handleplan-runtime-shipment-binding.json /app/.handleplan-release/runtime/handleplan-runtime-shipment-binding.json
COPY --from=builder --chown=nextjs:nodejs /app/.handleplan-runtime-stage/apps/worker /app/apps/worker
COPY --from=builder --chown=nextjs:nodejs /app/.handleplan-runtime-stage/node_modules /app/node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.handleplan-runtime-stage/deploy /app/deploy

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
