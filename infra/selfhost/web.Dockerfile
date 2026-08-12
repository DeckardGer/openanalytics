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

# THE THREE PUBLIC URLS ARE COMPILED IN — SO THIS BUILDS AGAINST PLACEHOLDERS.
#
# Next.js inlines every `NEXT_PUBLIC_*` value into the browser bundle at build
# time. The dashboard's calls to the api, the SSE stream and the collector are
# made by the visitor's browser, so those three origins end up inside the
# compiled output rather than being read from the container's environment.
#
# That is workable for an image you build on your own host and impossible for
# one that is PUBLISHED: an image built with our hostnames would send every
# other install's dashboard to our servers. Since v0.1.0 this repository
# publishes these images to a registry, so the build uses three reserved
# sentinel origins under `.invalid`, stashes the handful of built files that
# contain them, and `apps/web/docker-entrypoint.sh` substitutes the real values
# from the environment at container start.
#
# The sentinels are duplicated in that script. They have to agree: the stash
# below is keyed on finding them, and the entrypoint refuses to start if one
# survives substitution — which is what catches a change made in only one place.
ARG NEXT_PUBLIC_API_URL=https://api.oa-runtime-url.invalid
ARG NEXT_PUBLIC_REALTIME_URL=https://rt.oa-runtime-url.invalid
ARG NEXT_PUBLIC_COLLECTOR_URL=https://c.oa-runtime-url.invalid
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

# Stash the pristine copy of every built file that carries a sentinel, so the
# entrypoint can substitute from it on EVERY start rather than editing in place
# once. Without the stash, a container restarted with a different api hostname
# would keep serving the first one — the sentinel it needs to find would already
# be gone.
#
# An empty list is a build failure, not an empty stash: it means the placeholders
# did not reach the output — a renamed variable, or a build that read the values
# from somewhere else — and the image would then be unfixable at run time while
# looking perfectly well.
RUN set -eu; \
	cd /repo/apps/web; \
	grep -rl 'oa-runtime-url.invalid' .next >/tmp/oa-url-files || true; \
	if [ ! -s /tmp/oa-url-files ]; then \
	echo "no built file contains the placeholder origins — did NEXT_PUBLIC_* stop reaching the bundle?" >&2; \
	exit 1; \
	fi; \
	rm -rf .next-urls; \
	while IFS= read -r f; do \
	mkdir -p ".next-urls/$(dirname "$f")"; \
	cp "$f" ".next-urls/$f"; \
	done </tmp/oa-url-files; \
	cp /tmp/oa-url-files .next-urls/FILES; \
	echo "stashed $(wc -l <.next-urls/FILES) file(s) carrying a placeholder origin"

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

# The entrypoint substitutes this deployment's three origins into the stashed
# files and then execs `next start`. It is run through `sh` rather than executed
# directly, so the image does not depend on a mode bit surviving a checkout.
CMD ["sh", "/repo/apps/web/docker-entrypoint.sh"]
