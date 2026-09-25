#!/bin/sh
# Runs the start-up preflight for the two long-running roles (web, worker), then hands over to the real command.
# Anything else (prisma, create-operator, a shell) is passed straight through.
set -e
case "$*" in
  *next*start*)        role=web ;;
  *workers/main*)      role=worker ;;
  *)                   role="" ;;
esac
if [ -n "$role" ] && [ "${SS_PREFLIGHT:-true}" != "false" ]; then
  node preflight.mjs "$APP" "$role" || exit $?
fi
exec "$@"
