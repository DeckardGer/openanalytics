#!/usr/bin/env bash
# Upgrade this deployment to the version of the tree you are standing in.
#
#   git fetch --tags && git checkout v0.2.0
#   cd infra/selfhost && ./upgrade.sh
#
# Run it from the NEW checkout: the script that performs the upgrade ships with
# the version being upgraded to, so it already knows what that version needs.
#
# ## What it does, in order
#
#   1. works out which images this checkout wants;
#   2. tells you the three costs below and waits for a yes;
#   3. takes a cold snapshot of both stores — `./snapshot.sh create` — which
#      stops the stack;
#   4. writes the new tag into `.env`;
#   5. pulls (or builds) and brings everything up. Migrations run first and the
#      services wait for them, so a failed migration stops the upgrade instead
#      of leaving a fleet of services against a half-built schema.
#
# ## THERE IS NO DOWN MIGRATION, AND THAT IS THE DESIGN
#
# Migrations here are forward-only. Going back a version is therefore not
# "migrate down" — it is a RESTORE of the snapshot step 3 took, which is what
# `./rollback.sh` does. The consequence is the second cost below, and it is
# stated before the upgrade starts rather than in the rollback instructions,
# because that is where somebody can still decide differently.
set -euo pipefail

cd "$(dirname "$0")"

TARGET=""
FROM_SOURCE=0
ASSUME_YES=0
SKIP_BACKUP=0
KEEP=""

die() {
	echo "upgrade: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'USAGE'
usage: ./upgrade.sh [--to <vX.Y.Z>] [--from-source] [--keep <n>] [--yes]

  --to           the release to run. Defaults to the tag this checkout is on,
                 which is what you want after `git checkout vX.Y.Z`.
  --from-source  build the images here instead of pulling them. What to use on
                 an architecture the release does not publish, or to run a
                 branch. Needs the build toolchain and about ten minutes.
  --keep         keep only the newest <n> snapshots afterwards. Default: keep
                 everything, and print how much room they are taking.
  --yes          do not ask. For a scripted upgrade whose costs you have
                 already accepted; the three of them are printed either way.
  --skip-backup  UPGRADE WITH NO WAY BACK. Only sensible when you have just
                 taken a snapshot by hand, or when this install holds nothing
                 you would miss.
USAGE
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--to)
		TARGET="${2:-}"
		shift 2
		;;
	--from-source)
		FROM_SOURCE=1
		shift
		;;
	--keep)
		KEEP="${2:-}"
		shift 2
		;;
	--yes | -y)
		ASSUME_YES=1
		shift
		;;
	--skip-backup)
		SKIP_BACKUP=1
		shift
		;;
	-h | --help) usage ;;
	*) die "unknown argument '$1'" ;;
	esac
done

command -v docker >/dev/null 2>&1 || die "docker is required and was not found on PATH"
[ -f .env ] || die ".env is missing — run ./generate-secrets.sh first; this script upgrades an install, it does not create one"
[ -f docker-compose.override.yml ] || die "docker-compose.override.yml is missing — run ./generate-secrets.sh first"

DEFAULT_REPO="ghcr.io/openlabs-so/openanalytics"

# --- what are we upgrading to -----------------------------------------------
if [ "$FROM_SOURCE" -eq 1 ]; then
	[ -z "$TARGET" ] || die "--to and --from-source are for different things: one names a published release, the other builds this tree"
	NEW_TAG="local"
	NEW_REPO="openanalytics"
else
	if [ -z "$TARGET" ]; then
		# `--exact-match`, so a checkout that is merely NEAR a tag does not
		# claim to be it. A branch checkout lands in the error below, which is
		# the correct outcome: the images for an arbitrary commit do not exist.
		TARGET="$(git -C ../.. describe --tags --exact-match HEAD 2>/dev/null || true)"
	fi
	[ -n "$TARGET" ] || die "$(
		cat <<'MSG'
this checkout is not on a release tag, so there is no published image set for it.
         Either check one out:      git fetch --tags && git checkout v0.1.0
         or name one:               ./upgrade.sh --to v0.1.0
         or build this tree:        ./upgrade.sh --from-source
MSG
	)"
	case "$TARGET" in
	v[0-9]*) ;;
	*) die "'$TARGET' does not look like a release tag (vX.Y.Z)" ;;
	esac
	NEW_TAG="$TARGET"
	NEW_REPO="${OA_IMAGE_REPO:-$DEFAULT_REPO}"
fi

env_value() {
	local line
	line="$(grep -E "^$1=" .env | tail -1 || true)"
	[ -n "$line" ] && echo "${line#*=}" || echo ""
}

OLD_TAG="$(env_value OA_IMAGE_TAG)"
OLD_REPO="$(env_value OA_IMAGE_REPO)"

# A release checkout whose compose file predates OA_IMAGE_REPO. Not an error:
# `.env` is generated once and then belongs to the operator, so this script
# fills in what the newer compose file expects rather than telling them to.
[ -n "$OLD_REPO" ] || OLD_REPO="openanalytics"
[ -n "$OLD_TAG" ] || OLD_TAG="local"

# The checkout and the images have to be the same version — the compose file,
# the env templates and the migrations ship with the images. This catches the
# common shape of getting it wrong: pulling a release's images without checking
# out that release.
if [ "$FROM_SOURCE" -eq 0 ]; then
	HERE="$(git -C ../.. describe --tags --exact-match HEAD 2>/dev/null || echo '')"
	if [ -n "$HERE" ] && [ "$HERE" != "$NEW_TAG" ]; then
		die "this checkout is $HERE but you asked for $NEW_TAG. Check out $NEW_TAG first: the compose file and the migrations belong to the release, not just the images."
	fi
fi

# --- the costs ---------------------------------------------------------------
cat <<PLAN

Upgrading this deployment.

  from images   ${OLD_REPO}/*:${OLD_TAG}
  to images     ${NEW_REPO}/*:${NEW_TAG}
  tree          $(git -C ../.. describe --tags --always --dirty 2>/dev/null || echo 'unknown')

Three things this costs. None of them is recoverable after the fact, so they are
here rather than in the documentation:

  1. DOWNTIME, for as long as the snapshot and the restart take — minutes on a
     small install, longer with a large ClickHouse volume. Everything stops,
     including the collector, so events that visitors' browsers try to send
     during the window are REFUSED AND LOST. The tracker does not retry them.
     Pick a quiet hour.

  2. GOING BACK LOSES DATA. There are no down migrations, by decision, so
     ./rollback.sh restores the snapshot taken in a moment — and every event,
     account and setting recorded AFTER that snapshot is discarded with it. The
     further you get from this moment, the more expensive the decision to go
     back becomes. That is the trade this project made in exchange for never
     shipping a reverse migration that was written but never run.

  3. DISK. The snapshot is a compressed copy of both stores and nothing deletes
     it for you. ./snapshot.sh list shows what has accumulated; --keep prunes.

PLAN

if [ "$SKIP_BACKUP" -eq 1 ]; then
	cat <<'WARN'
  --skip-backup: NO SNAPSHOT WILL BE TAKEN. Cost 2 becomes total — there is no
  way back to the current state at all, and cost 1 still applies.

WARN
fi

if [ "$ASSUME_YES" -eq 0 ]; then
	printf 'Type yes to continue: '
	read -r answer
	[ "$answer" = "yes" ] || die "nothing was changed"
fi

# --- 1. the snapshot ---------------------------------------------------------
SNAPSHOT=""
if [ "$SKIP_BACKUP" -eq 0 ]; then
	label="pre-${NEW_TAG}"
	# `--no-start`: the stack is coming back up at the end of this script with
	# the NEW images, so starting the old ones in between would be two extra
	# restarts and a window in which the old code runs against a fresh snapshot.
	if [ -n "$KEEP" ]; then
		./snapshot.sh create --label "$label" --keep "$KEEP" --no-start
	else
		./snapshot.sh create --label "$label" --no-start
	fi
	# The newest snapshot with this label — captured so the rollback line printed
	# at the end names a real directory rather than a pattern to work out.
	SNAPSHOT="$(ls -d "${OA_BACKUP_DIR:-backups}"/*-"$label" 2>/dev/null | tail -1 || true)"
else
	echo "upgrade: stopping the stack"
	docker compose stop
fi

# --- 2. the new tag ----------------------------------------------------------
# Rewritten through a temp file: an in-place edit that fails half way through
# leaves a `.env` that names no images at all.
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

set_env OA_IMAGE_REPO "$NEW_REPO"
set_env OA_IMAGE_TAG "$NEW_TAG"
if [ "$FROM_SOURCE" -eq 1 ]; then
	set_env OA_GIT_COMMIT "$(git -C ../.. rev-parse HEAD 2>/dev/null || echo unknown)"
fi
echo "upgrade: .env now points at ${NEW_REPO}/*:${NEW_TAG}"

# --- 3. images ---------------------------------------------------------------
if [ "$FROM_SOURCE" -eq 1 ]; then
	echo "upgrade: building — this is the long part"
	docker compose build
else
	echo "upgrade: pulling ${NEW_REPO}/*:${NEW_TAG}"
	# A pull that fails here has changed nothing except `.env`, and the stack is
	# still stopped — so say what to do about it rather than leaving a bare
	# non-zero exit.
	if ! docker compose pull; then
		echo >&2
		echo "upgrade: the pull failed. Nothing has been upgraded and the stack is stopped." >&2
		echo '         "manifest unknown" usually means this tag published no images —' >&2
		echo '         check the release. "denied" means they are not public yet.' >&2
		echo "         Put it back with:  ./rollback.sh --to ${SNAPSHOT:-<snapshot>}" >&2
		echo "         Or just start what you had:  ./upgrade.sh --to ${OLD_TAG} --yes --skip-backup" >&2
		exit 1
	fi
fi

# --- 4. up -------------------------------------------------------------------
echo "upgrade: starting — migrations first, then the services that wait on them"
docker compose up -d

echo
echo "upgrade: done. ${OLD_TAG} -> ${NEW_TAG}"
echo
docker compose ps

cat <<DONE

Check the services are answering, and that they are the version you think:

  docker compose ps
  docker compose exec api node -e "fetch('http://127.0.0.1:8082/health').then(r=>r.json()).then(o=>console.log(o.commit,o.status))"

DONE

if [ -n "$SNAPSHOT" ]; then
	cat <<DONE
If this went badly:

  ./rollback.sh --to ${SNAPSHOT}

which restores the stores to the moment before this upgrade and discards
everything recorded since. Read cost 2 above again before running it.
DONE
fi
