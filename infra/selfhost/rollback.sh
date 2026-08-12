#!/usr/bin/env bash
# Go back to a snapshot: the stores, the configuration and the images together.
#
#   ./snapshot.sh list
#   ./rollback.sh --to backups/20260812T140000Z-pre-v0.2.0
#
# ## This is the only way back, and it is lossy
#
# Migrations here are forward-only — there are no down migrations, by decision.
# So "roll back" cannot mean "undo the schema change": it means put the data
# directories back the way they were and run the code that matches them.
#
# EVERYTHING RECORDED AFTER THE SNAPSHOT IS DISCARDED. Events, accounts, sites,
# tracking keys, event definitions, settings — all of it, because the stores are
# replaced wholesale rather than edited. There is no partial version of this
# operation and no merge.
#
# `./upgrade.sh` says so before it starts, which is the point where the choice is
# still cheap. If you are reading it here first: the number that matters is how
# long the deployment has been running the new version, because that is exactly
# what you are throwing away.
#
# ## What it puts back
#
#   * both data volumes, from the snapshot's archives;
#   * `env/*.env` and `docker-compose.override.yml` — the configuration that
#     matches those volumes. The current ones are moved aside first, never
#     deleted, so a rollback is itself reversible;
#   * `OA_IMAGE_REPO` / `OA_IMAGE_TAG` in `.env`, to the release the snapshot
#     was taken from, and then that release's images are pulled and started.
#
# It does NOT check the tree out for you. The compose file and the migrations
# belong to the version too, so a rollback across versions is:
#
#   git checkout v0.1.0 && cd infra/selfhost && ./rollback.sh --to <snapshot>
set -euo pipefail

cd "$(dirname "$0")"

FROM=""
ASSUME_YES=0
KEEP_CONFIG=0
PRE_BACKUP=1

die() {
	echo "rollback: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'USAGE'
usage: ./rollback.sh --to <snapshot dir> [--keep-config] [--no-pre-backup] [--yes]

  --to              which snapshot. ./snapshot.sh list shows them.
  --keep-config     do not restore env/*.env or the key-pair override. Use this
                    when you changed configuration AFTER the snapshot and want
                    to keep that change — a new SMTP password, say. The store
                    passwords must still match, so only do it if you know the
                    ones in place are the snapshot's.
  --no-pre-backup   do not snapshot the CURRENT state first. Faster, needs no
                    disk, and makes this irreversible.
  --yes             skip the confirmation. The confirmation is a typed word, not
                    a keypress, because of what this does.
USAGE
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--to)
		FROM="${2:-}"
		shift 2
		;;
	--keep-config)
		KEEP_CONFIG=1
		shift
		;;
	--no-pre-backup)
		PRE_BACKUP=0
		shift
		;;
	--yes | -y)
		ASSUME_YES=1
		shift
		;;
	-h | --help) usage ;;
	*) die "unknown argument '$1'" ;;
	esac
done

command -v docker >/dev/null 2>&1 || die "docker is required and was not found on PATH"
[ -n "$FROM" ] || usage
FROM="${FROM%/}"
[ -f "$FROM/manifest" ] || die "$FROM is not a snapshot (no manifest). ./snapshot.sh list shows what is."

manifest_value() {
	local line
	line="$(grep -E "^$1=" "$FROM/manifest" | tail -1 || true)"
	[ -n "$line" ] && echo "${line#*=}" || echo unknown
}

env_value() {
	[ -f .env ] || {
		echo unknown
		return
	}
	local line
	line="$(grep -E "^$1=" .env | tail -1 || true)"
	[ -n "$line" ] && echo "${line#*=}" || echo unknown
}

SNAP_VERSION="$(manifest_value oa_snapshot_version)"
[ "$SNAP_VERSION" = "1" ] || die "snapshot format $SNAP_VERSION is not one this script understands"

TAKEN_AT="$(manifest_value created_at)"
SNAP_REPO="$(manifest_value image_repo)"
SNAP_TAG="$(manifest_value image_tag)"
SNAP_TREE="$(manifest_value git_describe)"
NOW_TAG="$(env_value OA_IMAGE_TAG)"
HERE="$(git -C ../.. describe --tags --always --dirty 2>/dev/null || echo unknown)"

cat <<PLAN

Rolling this deployment back.

  snapshot      ${FROM}
  taken         ${TAKEN_AT}
  its tree      ${SNAP_TREE}
  its images    ${SNAP_REPO}/*:${SNAP_TAG}

  running now   ${NOW_TAG}
  this checkout ${HERE}

EVERYTHING RECORDED SINCE ${TAKEN_AT} WILL BE DISCARDED.

Both data volumes are replaced by the snapshot's copies. Every event collected
since, every account created since, every setting changed since: gone, with no
partial or merged outcome available. There are no down migrations to run instead
— this is the whole of the way back, by design.

PLAN

# The checkout has to match the images being restored, for the same reason the
# upgrade insists on it: the compose file, the env templates and the migration
# set are part of the version. Warned rather than refused, because an operator
# recovering from a bad upgrade may have good reasons and does not need a script
# arguing with them.
if [ "$SNAP_TAG" != "local" ] && [ "$HERE" != "$SNAP_TAG" ]; then
	cat <<WARN
NOTE: this checkout is ${HERE} and the snapshot came from ${SNAP_TAG}. The
compose file and the migration set belong to the version too, so unless you meant
this, stop and:

  git checkout ${SNAP_TAG}
  cd infra/selfhost && ./rollback.sh --to ${FROM}

WARN
fi

if [ "$ASSUME_YES" -eq 0 ]; then
	printf 'Type the snapshot name to confirm (%s): ' "$(basename "$FROM")"
	read -r answer
	[ "$answer" = "$(basename "$FROM")" ] || die "that did not match — nothing was changed"
fi

# --- the current state, before it is gone ------------------------------------
if [ "$PRE_BACKUP" -eq 1 ]; then
	echo "rollback: snapshotting the current state first, so this is reversible too"
	./snapshot.sh create --label "pre-rollback" --no-start
else
	echo "rollback: --no-pre-backup — the current state is not being saved"
fi

# --- the stores --------------------------------------------------------------
./snapshot.sh restore --from "$FROM" --no-start

# --- the configuration -------------------------------------------------------
if [ "$KEEP_CONFIG" -eq 0 ]; then
	aside="${OA_BACKUP_DIR:-backups}/config-before-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
	mkdir -p "$aside"
	chmod 700 "$aside"
	cp env/*.env "$aside/" 2>/dev/null || true
	[ -f docker-compose.override.yml ] && cp docker-compose.override.yml "$aside/"
	echo "rollback: the configuration in place has been copied to $aside/"

	cp "$FROM"/env/*.env env/
	chmod 600 env/*.env
	if [ -f "$FROM/docker-compose.override.yml" ]; then
		cp "$FROM/docker-compose.override.yml" docker-compose.override.yml
		chmod 600 docker-compose.override.yml
	fi
	echo "rollback: restored env/*.env and the key-pair override from the snapshot"
else
	echo "rollback: --keep-config — the configuration in place is untouched"
fi

# --- the images --------------------------------------------------------------
set_env() {
	local key="$1" value="$2" tmp
	tmp="$(mktemp)"
	if grep -qE "^$key=" .env; then
		awk -v k="$key" -v v="$value" -F= '$1 == k { print k "=" v; next } { print }' .env >"$tmp"
	else
		cat .env >"$tmp"
		printf '%s=%s\n' "$key" "$value" >>"$tmp"
	fi
	cat "$tmp" >.env
	rm -f "$tmp"
}

if [ "$SNAP_REPO" != "unknown" ] && [ "$SNAP_TAG" != "unknown" ]; then
	set_env OA_IMAGE_REPO "$SNAP_REPO"
	set_env OA_IMAGE_TAG "$SNAP_TAG"
	echo "rollback: .env points at ${SNAP_REPO}/*:${SNAP_TAG} again"
	if [ "$SNAP_TAG" != "local" ]; then
		docker compose pull
	fi
else
	echo "rollback: the snapshot did not record an image tag; leaving .env as it is" >&2
fi

echo "rollback: starting"
docker compose up -d

echo
echo "rollback: done — this deployment is the way it was at ${TAKEN_AT}"
docker compose ps
