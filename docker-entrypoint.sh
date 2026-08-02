#!/bin/bash
# Fetches runtime env from BreazyEnv (env.internal) and runs the app under the
# breazyenv supervisor: env values rotated in the BreazyEnv UI (or "Signal
# restart") gracefully restart the app within one poll interval.
# BREAZYENV_TOKEN (project token) is the only secret the deployment provides.
set -euo pipefail

: "${BREAZYENV_URL:=http://env.internal}"
: "${BREAZYENV_PROJECT:=outreachemailmcp-app}"
export BREAZYENV_URL

# The CLI is served by the BreazyEnv server itself; retry until reachable so a
# BreazyEnv outage delays boot instead of starting the app half-configured.
until curl -fsS --max-time 5 "$BREAZYENV_URL/breazyenv" -o /usr/local/bin/breazyenv; do
  echo "breazyenv: waiting for $BREAZYENV_URL to be reachable..." >&2
  sleep 3
done
chmod +x /usr/local/bin/breazyenv

mkdir -p /root/.breazyenv/tokens
chmod 700 /root/.breazyenv /root/.breazyenv/tokens
printf '%s' "${BREAZYENV_TOKEN:?Set BREAZYENV_TOKEN (project token from BreazyEnv)}" \
  > "/root/.breazyenv/tokens/$BREAZYENV_PROJECT"
chmod 600 "/root/.breazyenv/tokens/$BREAZYENV_PROJECT"

exec breazyenv run -p "$BREAZYENV_PROJECT" -- "$@"
