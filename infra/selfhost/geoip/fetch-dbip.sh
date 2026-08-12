#!/usr/bin/env bash
# Download the current DB-IP City Lite database into this directory.
#
#   ./fetch-dbip.sh            # this month, or last month if it is not out yet
#   ./fetch-dbip.sh --month 2026-07
#
# WHY DB-IP AND NOT MAXMIND. Both publish a free City-schema `.mmdb` and the
# schemas are interchangeable, so the reader does not care which one it opens.
# The licences are not interchangeable at all: GeoLite2 needs a MaxMind account
# and a licence key, and its EULA forbids redistribution — so we could neither
# fetch it for you without an account nor ship it. DB-IP City Lite is
# **CC BY 4.0**: a direct download, no account, and redistributable with
# attribution. That is the whole reason this script can exist.
#
# THE ATTRIBUTION IS A LICENCE CONDITION, not a courtesy. CC BY requires credit
# wherever the data is used, which is why this script prints the line and why it
# is in the repository's README. If you strip it you are out of compliance.
#
# THE FILE IS NOT COMMITTED. It is ~60 MB compressed, it is stale within a
# month, and a database in git history is a database in git history forever.
# `.gitignore` covers this directory's `.mmdb` files.
set -euo pipefail

cd "$(dirname "$0")"

MONTH=""

usage() {
	cat >&2 <<'USAGE'
usage: ./fetch-dbip.sh [--month YYYY-MM]

  --month   which monthly build to fetch. Defaults to the current month, and
            falls back to the previous one — a month's file appears a day or
            two into it, so the first of the month is a 404, not an error.

Writes dbip-city-lite.mmdb beside this script. The collector mounts this
directory at /geoip read-only; set GEOIP_DB_PATH=/geoip/dbip-city-lite.mmdb in
env/collector.env and recreate the collector.
USAGE
	exit 2
}

while [ $# -gt 0 ]; do
	case "$1" in
	--month)
		MONTH="${2:-}"
		shift 2
		;;
	-h | --help) usage ;;
	*)
		echo "fetch-dbip: unknown argument $1" >&2
		usage
		;;
	esac
done

if ! command -v curl >/dev/null 2>&1; then
	echo "fetch-dbip: curl is required" >&2
	exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
	echo "fetch-dbip: gzip is required" >&2
	exit 1
fi

OUT="dbip-city-lite.mmdb"
TMP="$(mktemp "${TMPDIR:-/tmp}/dbip.XXXXXX")"
trap 'rm -f "$TMP" "$TMP.gz"' EXIT

# Two candidates, in order, unless the caller named a month. The current build
# does not appear on the first of the month, and a self-hoster running this from
# `generate-secrets.sh` on the 1st should get a working database rather than a
# 404 they have to interpret.
if [ -n "$MONTH" ]; then
	CANDIDATES=("$MONTH")
else
	CANDIDATES=("$(date -u +%Y-%m)" "$(date -u -d '1 month ago' +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)")
fi

fetched=""
for month in "${CANDIDATES[@]}"; do
	url="https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz"
	echo "fetch-dbip: trying ${month}"
	# --fail so a 404 is a non-zero exit rather than an HTML error page saved as
	# a .gz, which would fail later inside gzip with nothing pointing here.
	if curl -fsSL --retry 2 --max-time 300 -o "$TMP.gz" "$url"; then
		fetched="$month"
		break
	fi
done

if [ -z "$fetched" ]; then
	echo "fetch-dbip: no build available for ${CANDIDATES[*]}" >&2
	echo "  Check https://db-ip.com/db/download/ip-to-city-lite for the current month." >&2
	exit 1
fi

gzip -dc "$TMP.gz" >"$TMP"

# Verified before it replaces a database that works. Every MaxMind-format file
# ends with the metadata marker \xab\xcd\xefMaxMind.com; a truncated download is
# otherwise a file the collector opens at boot and rejects, hours later and
# nowhere near this script.
if ! tail -c 200000 "$TMP" | grep -qa 'MaxMind.com'; then
	echo "fetch-dbip: the download is not a MaxMind-format database" >&2
	exit 1
fi

# Moved into place last, so an interrupted run leaves the previous database
# intact rather than a half-written one the collector will refuse.
mv "$TMP" "$OUT"
chmod 644 "$OUT"

size=$(du -h "$OUT" | cut -f1)
cat <<DONE

fetch-dbip: wrote $(pwd)/${OUT} (${fetched}, ${size})

  Set this in env/collector.env, then recreate the collector:

    GEOIP_DB_PATH=/geoip/${OUT}
    docker compose up -d --force-recreate collector

  ATTRIBUTION (required by CC BY 4.0 — keep it wherever the data is shown):

    IP Geolocation by DB-IP — https://db-ip.com

  Re-run this monthly. The database goes stale, and the collector reads it once
  at boot, so a refresh needs the recreate above.
DONE
