# ClickHouse, with the two files it cannot start correctly without.
#
# Upstream's image plus a config drop-in and the entrypoint that renders the
# four least-privilege users. Both used to arrive as bind mounts from this
# directory, which works for `docker compose up` in a checkout and fails
# everywhere else: a one-click platform writes the rendered compose file and
# nothing beside it, so Docker creates an empty **directory** for every missing
# bind source and the container dies with "oa-entrypoint.sh: Is a directory".
# Measured on Coolify 4.3.2, which is why this file exists.
#
# The build context is the repository ROOT, like every other image here, so the
# paths below are repo-relative and one copy of each file serves both the image
# and anyone reading it in the tree.
FROM clickhouse/clickhouse-server:26.3.17.56

# Listen addresses, log levels and the rest of the server-level policy.
COPY infra/selfhost/clickhouse/config.d/openanalytics.xml \
     /etc/clickhouse-server/config.d/openanalytics.xml

# WITHOUT THIS A DEPLOYMENT HAS NO CLICKHOUSE USERS AT ALL. It re-renders the
# `users.d` drop-in on every start and never depends on first-boot init, so a
# volume that predates a grant change still gets the new grants. Read its own
# header before changing it.
COPY infra/selfhost/clickhouse/oa-entrypoint.sh /usr/local/bin/oa-entrypoint.sh

# 0555, not 0755: nothing should be able to rewrite the script that decides who
# may read the events table. Owned by root and readable by the clickhouse user.
RUN chmod 0555 /usr/local/bin/oa-entrypoint.sh

# Named rather than inherited, so `docker run` on this image alone behaves the
# way compose does. An operator overriding it is overriding the user rendering.
ENTRYPOINT ["bash", "/usr/local/bin/oa-entrypoint.sh"]
