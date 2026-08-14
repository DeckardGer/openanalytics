# One image definition for every Node service in the monorepo.
#
# The build context is the repository ROOT, not the app directory: these are
# pnpm workspace packages whose dependencies resolve through the root lockfile,
# so an app-scoped context could not produce a reproducible install.
#
# Select the service with `--build-arg APP=query-gateway`.

# D-203 pins the exact patch locally, in CI and on the server. `24.x` would let
# the runtime drift away from the version the lockfile was resolved against.
FROM node:24.18.0-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /repo

# ---- dependencies -------------------------------------------------------
# Manifests only, so this layer is reused whenever sources change but
# dependencies do not.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps ./apps
COPY packages ./packages
# --frozen-lockfile: a stale lockfile must fail the build rather than silently
# resolving something the repository never tested.
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm run build

# The browser tracker, built here so it ships INSIDE the images.
#
# `scripts/` is copied for one reason: `pnpm run tracker:build` is
# `node scripts/build-tracker.mjs`, and without it the command cannot run. The
# stock compose hid that by bind-mounting the directory from a checkout, which a
# one-click platform install does not have — so `tracker-build` there inherited
# this stage's bare `node`, read EOF from a closed stdin, exited 0, and left the
# shared volume empty while reporting success. Every Coolify install from v0.3.0
# to v0.3.2 served `404` for the one file a customer pastes.
#
# It lands in every image rather than only the collector's because the runtime
# stage copies `/repo` wholesale and a ten-kilobyte bundle is not worth a second
# stage to keep out of five of them. `apps/collector/src/tracker-script.ts` is
# what serves it.
#
# Last, and after `pnpm run build`, so a change to `scripts/` does not invalidate
# the layer that compiles the whole monorepo.
COPY scripts ./scripts
RUN pnpm run tracker:build
# A budget failure already exits non-zero, and esbuild fails on a missing entry.
# This covers the third case: a run that succeeded and wrote nothing. Same
# reasoning as the `APP` guard below — fail where the image is built, not where
# it is served.
RUN test -s apps/tracker/bundle/oa.js || (echo "tracker bundle missing after build" && exit 1)

# ---- runtime ------------------------------------------------------------
FROM base AS runtime
ARG APP
ENV NODE_ENV=production
# Fail at build time rather than shipping an image whose entrypoint does not
# exist, which would otherwise only surface as a crash loop after deploy.
RUN test -n "$APP" || (echo "APP build-arg is required" && exit 1)

COPY --from=build /repo /repo
WORKDIR /repo

# Drop privileges. The `node` user ships with the base image.
USER node

ENV APP_MAIN="apps/${APP}/dist/main.js"

# The commit this image was built from, stamped into the image rather than
# supplied at run time.
#
# Every service already reads it — `GIT_COMMIT` is in the shared env schema
# (`packages/domain/src/env.ts`, default `unknown`), each `bootstrap.ts` passes
# it to `createServiceMetadata`, and `/health` publishes it. The only missing
# link was the build, so production answered `"commit":"unknown"` and there was
# no way to ask a running service which commit it was — the gap that let an api
# fix sit undeployed for two days on 2026-08-08 while every signal stayed green.
#
# **A run-time variable would be the wrong home.** The commit is a property of
# the image, not of the deployment: set it in compose and a restart with a stale
# file relabels the same bytes as a different commit, which is worse than
# `unknown` because it looks authoritative.
#
# Last in the file on purpose. It changes on every build, and anything below it
# in the layer order would lose its cache with it; here it invalidates one
# metadata layer and nothing else.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

CMD ["sh", "-c", "exec node \"$APP_MAIN\""]
