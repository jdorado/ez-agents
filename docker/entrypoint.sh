#!/bin/sh -p
set -eu
umask 077
runtime_uid=${EZ_RUNTIME_UID:-1000}
runtime_gid=${EZ_RUNTIME_GID:-1000}
relay_uid=${EZ_RELAY_UID:-1001}
for runtime_id in "$runtime_uid" "$runtime_gid" "$relay_uid"; do
  case "$runtime_id" in
    ''|*[!0-9]*|0*) echo 'Runtime UID/GID values must be positive decimal IDs' >&2; exit 64 ;;
  esac
  if [ "${#runtime_id}" -gt 10 ] || [ "$runtime_id" -gt 2147483647 ]; then
    echo 'Runtime UID/GID values must not exceed 2147483647' >&2; exit 64
  fi
done
if [ "$runtime_uid" = "$relay_uid" ]; then
  echo 'EZ_RELAY_UID must differ from EZ_RUNTIME_UID to isolate relay secrets' >&2
  exit 64
fi
if [ "$(id -u)" = 0 ]; then
  mkdir -p /state/control /state/home /workspace /run/secrets
  chmod 700 /run/secrets
  chown "$runtime_uid:$runtime_gid" /state/control /state/home /workspace
  if [ -f /run/secrets/relay_env ]; then exec 3</run/secrets/relay_env; else exec 3</dev/null; fi
  exec setpriv --ruid="$relay_uid" --euid="$runtime_uid" --regid="$runtime_gid" --clear-groups --bounding-set=-all --no-new-privs /app/docker/entrypoint.sh "$@"
fi
# Reserve the private environment descriptor before Node can use it for libuv.
# Root startup already opened it; preserve that inherited secret descriptor.
( : <&3 ) 2>/dev/null || exec 3</dev/null
case "${1:-start}" in
  start|smoke|exec|setup)
    exec flock --no-fork -n -E 73 /state/control/relay.lock node --import /app/node_modules/tsx/dist/loader.mjs /app/docker/run.ts "$@" ;;
  *) exec node --import /app/node_modules/tsx/dist/loader.mjs /app/docker/run.ts "$@" ;;
esac
