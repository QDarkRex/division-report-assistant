FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# db/migrate.ts reads migrationsFolder: "./drizzle" relative to cwd — was
# missing entirely from the runtime image (found 2026-08-08 trying to run
# a migration inside a container for the first time; every migration
# before this one ran from a dev machine via SSH tunnel, which has the
# full repo including this folder, so the gap went unnoticed).
COPY drizzle ./drizzle

RUN useradd --system --uid 10004 --home-dir /nonexistent --shell /usr/sbin/nologin wdh

USER 10004:10004

EXPOSE 8000

CMD ["node", "dist/app/server.js"]
