# Valkey, carrying both policy files and the entrypoint that applies one.
#
# The same reason as `clickhouse.Dockerfile`: these arrived as bind mounts,
# which a platform that writes only the rendered compose file turns into empty
# directories. See that file's header for the failure and where it was measured.
#
# **One image, two roles.** The queue and the realtime cache are the same
# server under different policy: the queue is durable and the cache is losable
# by design (D-205 keeps them apart so an eviction storm cannot reach an event
# that has been acknowledged and not yet inserted). Two images would be the same
# bytes twice and a second thing to keep in step, so both configs ship here and
# `OA_VALKEY_CONF` picks one.
FROM valkey/valkey:8-alpine

# Durable: appendonly, no eviction. Losable: allkeys-lru inside a memory bound.
COPY infra/selfhost/valkey/valkey-queue.conf /usr/local/etc/valkey/valkey-queue.conf
COPY infra/selfhost/valkey/valkey-realtime.conf /usr/local/etc/valkey/valkey-realtime.conf

# Composes the runtime config from the policy file plus the injected password,
# so the credential lands in a 0600 file and never in argv where `docker
# inspect` and every `ps` on the host would show it.
COPY infra/selfhost/valkey/valkey-entrypoint.sh /usr/local/bin/oa-valkey-entrypoint.sh
RUN chmod 0555 /usr/local/bin/oa-valkey-entrypoint.sh

# Which policy this container runs. No default that guesses: a cache config on
# the queue would silently evict acknowledged events, so the compose file names
# it and a container started without it refuses rather than picks.
ENV OA_VALKEY_CONF=""

ENTRYPOINT ["sh", "/usr/local/bin/oa-valkey-entrypoint.sh"]
