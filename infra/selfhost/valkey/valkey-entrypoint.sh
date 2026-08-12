#!/bin/sh
# Compose the runtime config from the mounted policy file plus the injected
# credential — the password lands in a 0600 file, never in argv, where
# `docker inspect` and every `ps` on the host would show it.
set -eu

: "${VALKEY_PASSWORD:?VALKEY_PASSWORD is required}"

RUNTIME_CONF=/tmp/valkey.runtime.conf

umask 077
cp /usr/local/etc/valkey/valkey.conf "$RUNTIME_CONF"
printf 'requirepass %s\n' "$VALKEY_PASSWORD" >>"$RUNTIME_CONF"

exec valkey-server "$RUNTIME_CONF"
