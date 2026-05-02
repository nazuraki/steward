#!/bin/sh
set -e

if [ "${STEWARD_MODE}" = "webhook" ]; then
    exec node --import tsx/esm packages/webhook-loop/src/index.ts
else
    exec node --import tsx/esm packages/runner/src/bin.ts
fi
