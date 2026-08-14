#!/bin/sh
# Compose the runtime config from the policy file plus the injected credential.
# The password lands in a 0600 file, never in argv, where `docker inspect` and
# every `ps` on the host would show it.
set -eu

: "${VALKEY_PASSWORD:?VALKEY_PASSWORD is required}"

# Which policy to apply. The image ships both and names neither as a default
# (`valkey.Dockerfile`), because a cache config on the queue would silently
# evict events that have been acknowledged and not yet inserted. Falling back to
# the classic mount path keeps a hand-rolled compose file working: anyone who
# bind-mounts a config at `/usr/local/etc/valkey/valkey.conf` and sets nothing
# gets exactly the old behaviour.
SOURCE_CONF="${OA_VALKEY_CONF:-/usr/local/etc/valkey/valkey.conf}"

if [ ! -f "$SOURCE_CONF" ]; then
  echo "oa-valkey-entrypoint: no config at \"$SOURCE_CONF\". Set OA_VALKEY_CONF to one of the files this image carries (/usr/local/etc/valkey/valkey-queue.conf, /usr/local/etc/valkey/valkey-realtime.conf) or mount your own at /usr/local/etc/valkey/valkey.conf. Refusing to start on a default that would be a guess about durability." >&2
  exit 1
fi

RUNTIME_CONF=/tmp/valkey.runtime.conf

umask 077
cp "$SOURCE_CONF" "$RUNTIME_CONF"
printf 'requirepass %s\n' "$VALKEY_PASSWORD" >>"$RUNTIME_CONF"

exec valkey-server "$RUNTIME_CONF"
