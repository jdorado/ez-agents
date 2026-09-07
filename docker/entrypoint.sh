#!/bin/sh -p
set -eu
umask 077
if [ "$(id -u)" = 0 ]; then
  mkdir -p /state/control /state/home /workspace /run/secrets
  chmod 700 /run/secrets
  chown 1000:1000 /state/control /state/home /workspace
  if [ -f /run/secrets/relay_env ]; then exec 3</run/secrets/relay_env; else exec 3</dev/null; fi
  exec setpriv --ruid=1001 --euid=1000 --regid=1000 --clear-groups --bounding-set=-all --no-new-privs /app/docker/entrypoint.sh "$@"
fi
case "${1:-start}" in
  start|smoke|exec|setup)
    exec flock --no-fork -n -E 73 /state/control/relay.lock node --import /app/node_modules/tsx/dist/loader.mjs /app/docker/run.ts "$@" ;;
  *) exec node --import /app/node_modules/tsx/dist/loader.mjs /app/docker/run.ts "$@" ;;
esac
