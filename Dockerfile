FROM node:22.22.3-alpine@sha256:f0a08e0402831ac4097e9825704bc2dfe6d2c1333de99686a89ca649159b02c8 AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/kassalapp/package.json packages/kassalapp/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
ARG APP_COMMIT_SHA=development
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
RUN pnpm --filter web build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres ./node_modules/postgres
COPY --from=builder --chown=nextjs:nodejs /app/deploy/entrypoint.sh /app/deploy/entrypoint.sh
COPY --from=builder --chown=nextjs:nodejs /app/deploy/migrate.mjs /app/deploy/migrate.mjs
COPY --from=builder --chown=nextjs:nodejs /app/deploy/migrations /app/deploy/migrations

USER nextjs
EXPOSE 3000
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
