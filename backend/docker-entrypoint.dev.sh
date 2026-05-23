#!/bin/sh
set -eu

mkdir -p /app/.bigset
chown -R node:node /app/.bigset

exec su-exec node "$@"
