FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# CLERK_PUBLISHABLE_KEY and APP_URL are deliberately NOT set here: the app reads them from
# process.env at request time (see src/app/layout.tsx, src/middleware.ts, src/lib/auth/oauth.ts),
# so the same image works across deployments without a rebuild — only .env at runtime matters.
# We pass a dummy MCP_MASTER_KEY so Next build doesn't fail if code touches it — prefer lazy reads.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV MCP_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
# `.next/standalone` only ships the Next server's own traced node_modules subset — not
# enough to run `drizzle-kit` (its CLI bin plus its full dependency tree), which
# `docker compose exec app npx drizzle-kit push` needs for the one-time schema push. Copy
# the builder's full node_modules (npm ci installed devDependencies too) over it instead.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
