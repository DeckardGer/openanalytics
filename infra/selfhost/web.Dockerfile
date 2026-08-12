# The dashboard image.
#
# Separate from `infra/docker/node-app.Dockerfile` because the two builds have
# nothing in common past the install: the backend services are `tsc --build`
# output started with `node dist/main.js`, and this is a Next.js application
# with its own compiler, its own output layout and its own server.
#
# The build context is the repository ROOT, same as the backend image and for
# the same reason: these are pnpm workspace packages whose dependencies resolve
# through the root lockfile.

# Pinned to the patch, like the backend image: `24.x` would let the runtime
# drift away from the version the lockfile was resolved against.
FROM node:24.18.0-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /repo

# ---- dependencies -------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# ---- build --------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./

# THE THREE PUBLIC URLS ARE COMPILED IN, NOT READ AT RUN TIME.
#
# Next.js inlines every `NEXT_PUBLIC_*` value into the browser bundle at build
# time. The dashboard's calls to the api, the SSE stream and the collector are
# made by the visitor's browser, so these are the values that end up in that
# bundle: changing a hostname means rebuilding this image, not restarting the
# container.
#
# They have no defaults here on purpose. `apps/web/lib/api.ts` falls back to the
# hosted service's own hostnames when they are unset, which for a self-hosted
# deployment produces a dashboard that renders perfectly and sends every request
# to someone else's server. Failing the build is the kinder outcome.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_COLLECTOR_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL build-arg is required" && exit 1)
RUN test -n "$NEXT_PUBLIC_REALTIME_URL" || (echo "NEXT_PUBLIC_REALTIME_URL build-arg is required" && exit 1)
RUN test -n "$NEXT_PUBLIC_COLLECTOR_URL" || (echo "NEXT_PUBLIC_COLLECTOR_URL build-arg is required" && exit 1)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}
ENV NEXT_PUBLIC_COLLECTOR_URL=${NEXT_PUBLIC_COLLECTOR_URL}

# Telemetry off. A self-hosted analytics product that phones a third party
# during its own build would be a poor joke.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# `pnpm --filter @openanalytics/web build` runs the workspace's `prebuild`
# first, which compiles the contracts package the dashboard imports.
RUN pnpm --filter @openanalytics/web build

# ---- runtime ------------------------------------------------------------
# The whole workspace is carried into the runtime image rather than Next's
# `standalone` output. Standalone would be smaller, but it is an opt-in build
# mode set in `apps/web/next.config.ts` — a file this deployment concern has no
# business editing — and its dependency tracing has to be re-verified against
# every Next upgrade. `next start` over the installed workspace is the shape the
# repository already supports and tests.
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=build /repo /repo
WORKDIR /repo/apps/web

# `next start` writes into `.next/cache` while it serves, and the tree above
# arrives owned by root. Only that directory is chowned — `--chown` on the COPY
# would rewrite every layer of a workspace install for the sake of one cache
# directory. Without this the server starts and then fails on its first cache
# write, which reads as an application bug rather than a permissions one.
RUN chown -R node:node /repo/apps/web/.next

# Drop privileges. The `node` user ships with the base image.
USER node

EXPOSE 3000

# The commit this image was built from, stamped into the image rather than
# supplied at run time — same reasoning as the backend image. Last in the file
# because it changes on every build.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

# The binary directly, not `pnpm exec next`: pnpm wants a writable home and
# store at run time, and the unprivileged user above has neither. The workspace
# install already links `next` here.
CMD ["sh", "-c", "exec node_modules/.bin/next start --port ${PORT} --hostname 0.0.0.0"]
