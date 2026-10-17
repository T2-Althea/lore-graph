#!/usr/bin/env bash
# One-time setup: SillyTavern (release branch) in dev/.work/sillytavern, configured for local
# testing (port 8123, no browser launch, no auto-updates), plus Playwright for the e2e scripts.
set -euo pipefail
DEV="$(cd "$(dirname "$0")" && pwd)"
ST="$DEV/.work/sillytavern"
mkdir -p "$DEV/.work"
if [ ! -d "$ST" ]; then
    git clone --depth 1 -b release https://github.com/SillyTavern/SillyTavern.git "$ST"
fi
(cd "$ST" && npm ci --no-audit --no-fund)
sed -e '0,/  enabled: true/s//  enabled: false/' \
    -e 's/^port: 8000/port: 8123/' \
    -e 's/  autoUpdate: true/  autoUpdate: false/' \
    -e 's/  autoDownload: true/  autoDownload: false/' \
    "$ST/default/config.yaml" > "$ST/config.yaml"
(cd "$DEV" && npm install --no-audit --no-fund)
echo "Setup done. Run dev/run-all.sh"
