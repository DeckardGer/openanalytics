#!/bin/sh
# Start the dashboard with THIS deployment's three public origins.
#
# ## Why this file exists
#
# Next.js inlines every `NEXT_PUBLIC_*` value into the browser bundle at build
# time. The dashboard's calls to the api, the SSE stream and the collector are
# made by the visitor's browser, so those three origins are compiled into the
# image — which is fine for an image you build yourself and impossible for one
# you publish, because a published image would carry whoever built it's
# hostnames into everybody else's install.
#
# So the image is built against three reserved sentinel origins under
# `.invalid`, and the handful of built files that contain them are stashed
# beside the build. This script restores those files from the stash and
# substitutes the real values into them before `next start` ever runs.
#
# Restoring from the stash rather than editing in place is what makes it
# repeatable: after one substitution the sentinel is gone, so a container
# restarted with a different `NEXT_PUBLIC_API_URL` would otherwise keep serving
# the first one.
#
# ## Why it fails closed
#
# A dashboard pointed at the wrong origin does not look broken. It renders, and
# every request goes somewhere else — which is the one outcome worth exiting
# for. So: a missing value is fatal, a value that is not a bare origin is fatal,
# and a sentinel still present in the output after substitution is fatal. The
# container not starting is a legible failure; the alternative is not.
set -eu

APP_DIR=/repo/apps/web
STASH="$APP_DIR/.next-urls"
SENTINEL_HOST='oa-runtime-url.invalid'

cd "$APP_DIR"

# The three, in the order they are substituted. Same sentinels as
# infra/selfhost/web.Dockerfile — change them in both places or the build's
# stash and this script's `sed` stop describing the same strings, and the
# guard at the bottom is what would catch it.
sentinel_for() {
	case "$1" in
	NEXT_PUBLIC_API_URL) echo "https://api.$SENTINEL_HOST" ;;
	NEXT_PUBLIC_REALTIME_URL) echo "https://rt.$SENTINEL_HOST" ;;
	NEXT_PUBLIC_COLLECTOR_URL) echo "https://c.$SENTINEL_HOST" ;;
	esac
}

# A bare origin: scheme, host, optional port. No path, no query, no trailing
# slash. Two reasons, and the second is the load-bearing one:
#
#   * every consumer of these joins a path onto them, so a trailing slash
#     produces `//v1/...` and a path prefix produces a URL nobody intended;
#   * the substitution below is `sed`, and a value carrying `|` or `&` would
#     change what the expression means rather than what it inserts.
#
# A trailing slash is the one mistake common enough to fix rather than refuse.
normalise_origin() {
	printf '%s' "$1" | sed 's|/*$||'
}

for name in NEXT_PUBLIC_API_URL NEXT_PUBLIC_REALTIME_URL NEXT_PUBLIC_COLLECTOR_URL; do
	eval "raw=\${$name:-}"
	if [ -z "$raw" ]; then
		echo "web: $name is required — it is the origin the browser calls." >&2
		echo "     Set all three in infra/selfhost/env/web.env." >&2
		exit 1
	fi
	value="$(normalise_origin "$raw")"
	case "$value" in
	https://* | http://*) ;;
	*)
		echo "web: $name must start with http:// or https://: got '$raw'" >&2
		exit 1
		;;
	esac
	case "${value#*://}" in
	'' | *[!a-zA-Z0-9.:-]*)
		echo "web: $name must be a bare origin — scheme, host, optional port, nothing else: got '$raw'" >&2
		exit 1
		;;
	esac
	eval "${name}_VALUE=\$value"
done

# The stash is written by the build. Its absence means this image was not built
# by infra/selfhost/web.Dockerfile — a case worth naming rather than starting
# into.
if [ ! -f "$STASH/FILES" ]; then
	echo "web: $STASH/FILES is missing; this image was not built with runtime origins." >&2
	exit 1
fi

count=0
while IFS= read -r file; do
	[ -n "$file" ] || continue
	cp "$STASH/$file" "$file"
	sed -i \
		-e "s|$(sentinel_for NEXT_PUBLIC_API_URL)|$NEXT_PUBLIC_API_URL_VALUE|g" \
		-e "s|$(sentinel_for NEXT_PUBLIC_REALTIME_URL)|$NEXT_PUBLIC_REALTIME_URL_VALUE|g" \
		-e "s|$(sentinel_for NEXT_PUBLIC_COLLECTOR_URL)|$NEXT_PUBLIC_COLLECTOR_URL_VALUE|g" \
		"$file"
	count=$((count + 1))
done <"$STASH/FILES"

# Fail closed. If any sentinel survived, the browser bundle would point at
# `.invalid` and every call from the dashboard would fail DNS — visibly, but
# only for whoever opened it, and only after deploy.
if grep -rl "$SENTINEL_HOST" .next >/dev/null 2>&1; then
	echo "web: a build-time placeholder survived substitution in:" >&2
	grep -rl "$SENTINEL_HOST" .next >&2 || true
	exit 1
fi

echo "web: serving ${NEXT_PUBLIC_API_URL_VALUE} (api), ${NEXT_PUBLIC_REALTIME_URL_VALUE} (realtime), ${NEXT_PUBLIC_COLLECTOR_URL_VALUE} (collector) — ${count} files rewritten"

# The binary directly, not `pnpm exec next`: pnpm wants a writable home and
# store at run time, and the unprivileged user this runs as has neither.
exec node_modules/.bin/next start --port "${PORT:-3000}" --hostname 0.0.0.0
