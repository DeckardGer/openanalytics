#!/bin/sh
# fork: print the slim backend Dockerfile for one upstream release.
#
#   infra/docker/fork-backend-dockerfile.sh <node-app.Dockerfile> <fork-backend.stages>
#
# Upstream's stages up to `# ---- runtime`, then the fork's stages, with
# `__NODE_IMAGE__` set to the image upstream's `base` stage uses. Both markers
# are checked rather than assumed: if upstream renames either, the build stops
# here instead of producing an image assembled from the wrong pieces.
set -eu

upstream=$1
stages=$2

grep -q '^# ---- runtime' "$upstream" || {
  echo "fork-backend: no '# ---- runtime' line in $upstream; update this script" >&2
  exit 1
}
node_image=$(sed -n 's/^FROM \([^ ]*\) AS base$/\1/p' "$upstream")
[ -n "$node_image" ] || {
  echo "fork-backend: no 'FROM <image> AS base' line in $upstream; update this script" >&2
  exit 1
}

sed '/^# ---- runtime/,$d' "$upstream"
sed "s|__NODE_IMAGE__|$node_image|" "$stages"
