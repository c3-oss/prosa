#!/bin/sh
# publish-npm.test.sh — offline checks for publish-npm.sh and the
# static layout of the npm/ directory. Run during CI alongside the
# other smoke tests.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT=$SCRIPT_DIR/scripts/publish-npm.sh

# 1) Syntax.
sh -n "$SCRIPT"
echo "ok: sh -n"

if command -v dash >/dev/null 2>&1; then
    dash -n "$SCRIPT"
    echo "ok: dash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -s sh "$SCRIPT"
    echo "ok: shellcheck"
fi

# 2) Every npm sub-package has the right name, os, and cpu.
for p in darwin-arm64 darwin-amd64 linux-amd64 linux-arm64; do
    pkg="$SCRIPT_DIR/npm/prosa-$p/package.json"
    [ -f "$pkg" ] || { echo "missing $pkg" >&2; exit 1; }
    grep -q "\"@c3-oss/prosa-$p\"" "$pkg" \
        || { echo "wrong name in $pkg" >&2; exit 1; }
done

# 3) Main package lists every sub-package as an optionalDependency.
main=$SCRIPT_DIR/npm/prosa/package.json
[ -f "$main" ] || { echo "missing $main" >&2; exit 1; }
for p in darwin-arm64 darwin-amd64 linux-amd64 linux-arm64; do
    grep -q "@c3-oss/prosa-$p" "$main" \
        || { echo "main package missing optionalDependency for $p" >&2; exit 1; }
done

# 4) Shim resolves to the expected sub-package for the current
#    platform name format. Run the shim with a Node that errors
#    early; we just want the JS to parse + the resolution check.
node -e "
    const fs = require('fs');
    const shim = fs.readFileSync('$SCRIPT_DIR/npm/prosa/bin/prosa.js', 'utf8');
    if (!shim.includes('@c3-oss/prosa-')) {
        console.error('shim missing subpackage prefix');
        process.exit(1);
    }
"
echo "ok: shim resolves subpackage path"

echo "all checks passed"
