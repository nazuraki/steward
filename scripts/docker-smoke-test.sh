#!/usr/bin/env bash
# End-to-end container smoke test.
# Builds the image, runs with --network none and stub credentials,
# and verifies the container starts and exits with a controlled failure
# (network/auth error), not a crash.
set -euo pipefail

IMAGE="steward:smoke-test"
PASS=0
FAIL=1

echo "=== steward docker smoke test ==="

echo ""
echo "--- Building image ---"
docker build --quiet -t "$IMAGE" .
echo "Image built: $IMAGE"

echo ""
echo "--- Running container (--network none, stub credentials) ---"
# The container should: start up, attempt GitHub API validation, fail gracefully.
set +e
output=$(docker run --rm \
    --network none \
    -e GITHUB_TOKEN=smoke-test-token \
    -e ANTHROPIC_API_KEY=smoke-test-key \
    -e GITHUB_REPO=smoke/test \
    -e LOG_DIR=/tmp/steward-smoke-logs \
    "$IMAGE" 2>&1)
exit_code=$?
set -e

echo "Exit code: $exit_code"
echo "Output:"
echo "$output"
echo ""

# Expect non-zero exit (app can't reach GitHub with --network none)
if [ "$exit_code" -eq 0 ]; then
    echo "FAIL: container exited 0 — expected failure with no network/real credentials"
    exit $FAIL
fi

# Expect a controlled startup message, not a crash (no unhandled exception / node crash)
if echo "$output" | grep -qE "^\[steward\]"; then
    echo "PASS: container started and failed gracefully ([steward] output found)"
else
    echo "FAIL: no [steward] startup output found — container may have crashed before running"
    exit $FAIL
fi

# Ensure it's not a node crash (would show "node: --import" or uncaught exception)
if echo "$output" | grep -qE "^node:|SyntaxError:|Cannot find module"; then
    echo "FAIL: node startup error detected"
    exit $FAIL
fi

echo ""
echo "=== Smoke test passed ==="
exit $PASS
