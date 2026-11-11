#!/bin/sh
# Starts the server and restarts it when it exits. Deployment values (WORKBENCH_OWNER,
# WORKBENCH_HOST and the optional ones in local.env.example) come from the environment
# or from local.env next to this script.
cd "$(dirname "$0")" || exit 1
if [ -f ./local.env ]; then
  set -a
  . ./local.env
  set +a
fi
: "${WORKBENCH_OWNER:?set WORKBENCH_OWNER (see local.env.example)}"
: "${WORKBENCH_HOST:?set WORKBENCH_HOST (see local.env.example)}"
export PATH="$HOME/.local/bin:$PATH"
while true; do
 node server.mjs
 sleep 3
done
