#!/usr/bin/env bash
# Runs everything: unit tests, then every e2e script against a fresh SillyTavern user folder
# with the fake AI backend. Servers are started here and stopped at the end.
# Usage: dev/run-all.sh [e2e-name-filter]
set -uo pipefail
DEV="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DEV")"
ST="$DEV/.work/sillytavern"
LOGS="$DEV/.work/logs"
FILTER="${1:-}"
[ -d "$ST" ] || { echo "SillyTavern missing: run dev/setup.sh first"; exit 1; }
mkdir -p "$LOGS" "$DEV/screenshots"
# A full run starts with an empty screenshots folder, so only this run's pictures are there.
[ -z "$FILTER" ] && find "$DEV/screenshots" -maxdepth 1 -name '*.png' -delete

echo "== Unit tests"
(cd "$DEV" && node --test unit/*.test.js 2>&1 | tail -9)
UNIT=${PIPESTATUS[0]}

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT

# Install the extension the way SillyTavern does for a GitHub install (a copy in the user's
# extensions folder), minus dev/ and .git.
reset_st_user() {
    rm -rf "$ST/data/default-user"
    mkdir -p "$ST/data/default-user/extensions/lore-graph"
    (cd "$ROOT" && tar --exclude=./dev --exclude=./.git -cf - .) | tar -xf - -C "$ST/data/default-user/extensions/lore-graph"
    # Skip the first-run welcome popup (it holds up settings loading until answered).
    sed 's/"firstRun": true/"firstRun": false/' "$ST/default/content/settings.json" > "$ST/data/default-user/settings.json"
}

start_servers() {
    if curl -s -o /dev/null http://127.0.0.1:8123/ || curl -s -o /dev/null http://127.0.0.1:8124/v1/models; then
        echo "Port 8123 or 8124 is already in use (a server left running?). Stop it first."; return 1
    fi
    node "$DEV/fake-backend.js" 8124 > "$LOGS/fake.log" 2>&1 & PIDS+=($!)
    pushd "$ST" > /dev/null
    node server.js > "$LOGS/st.log" 2>&1 & PIDS+=($!)
    popd > /dev/null
    for i in $(seq 1 120); do
        curl -s -o /dev/null http://127.0.0.1:8123/ && curl -s -o /dev/null http://127.0.0.1:8124/v1/models && return 0
        sleep 1
    done
    echo "Servers did not start; see $LOGS"; return 1
}

E2E_PASS=0; E2E_FAIL=0; FAILED=()
for script in "$DEV"/e2e/*.mjs; do
    name="$(basename "$script" .mjs)"
    [ "$name" = lib ] && continue
    [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]] && continue
    echo "== e2e: $name"
    cleanup; PIDS=()
    reset_st_user
    start_servers || exit 1
    if (cd "$DEV" && node "$script"); then E2E_PASS=$((E2E_PASS+1)); else E2E_FAIL=$((E2E_FAIL+1)); FAILED+=("$name"); fi
done
cleanup; PIDS=()

echo
echo "== Summary"
[ "$UNIT" = 0 ] && echo "Unit tests: passed" || echo "Unit tests: FAILED"
echo "e2e scripts: $E2E_PASS passed, $E2E_FAIL failed ${FAILED[*]:-}"
echo "Screenshots: $DEV/screenshots"
[ "$UNIT" = 0 ] && [ "$E2E_FAIL" = 0 ]
