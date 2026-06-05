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

# 4) Shim parses as ESM and still references the subpackage prefix.
#    node --check catches ESM syntax regressions; the grep guards
#    against accidentally removing the require.resolve target.
node --check "$SCRIPT_DIR/npm/prosa/bin/prosa.js"
echo "ok: node --check"

if ! grep -q '@c3-oss/prosa-' "$SCRIPT_DIR/npm/prosa/bin/prosa.js"; then
    echo "shim missing @c3-oss/prosa- subpackage prefix" >&2
    exit 1
fi
echo "ok: shim references subpackage prefix"

# 5) The Node shim must translate Node's architecture names to the
#    package suffixes used by the release artifacts. In particular,
#    process.arch reports x64, while the package is linux-amd64.
#    Use a fake optionalDependency through NODE_PATH so this stays
#    offline and does not need a real release binary.
if [ "$(node -p 'process.platform')" = "linux" ] && [ "$(node -p 'process.arch')" = "x64" ]; then
    tmp=${TMPDIR:-/tmp}/prosa-npm-shim-test-$$
    trap 'rm -rf "$tmp"' EXIT INT TERM
    mkdir -p "$tmp/node_modules/@c3-oss/prosa-linux-amd64/bin"
    cat >"$tmp/node_modules/@c3-oss/prosa-linux-amd64/bin/prosa" <<'EOF'
#!/bin/sh
echo "fake prosa $*"
EOF
    chmod 0755 "$tmp/node_modules/@c3-oss/prosa-linux-amd64/bin/prosa"
    out=$(NODE_PATH="$tmp/node_modules" node "$SCRIPT_DIR/npm/prosa/bin/prosa.js" --version)
    [ "$out" = "fake prosa --version" ] \
        || { echo "shim failed to execute linux-amd64 fake binary: $out" >&2; exit 1; }
    rm -rf "$tmp"
    trap - EXIT INT TERM
    echo "ok: shim maps linux/x64 to linux-amd64"
fi

echo "all checks passed"
