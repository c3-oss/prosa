#!/bin/sh
# publish-npm.sh — copy goreleaser artifacts into npm/* subpackages,
# stamp them with the release version, validate cross-package
# version coherence, and `npm publish` each.
#
# Designed to run after goreleaser inside .github/workflows/release.yml.
# Requires Node.js in PATH (used for portable package.json edits) and
# NODE_AUTH_TOKEN set to a valid npm token for @c3-oss/*.

set -eu

if [ -z "${GITHUB_REF_NAME:-}" ]; then
    echo "GITHUB_REF_NAME not set (expected the tag, e.g. v0.11.0)" >&2
    exit 1
fi
VERSION="${GITHUB_REF_NAME#v}"

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
NPM_ROOT=$SCRIPT_DIR/npm
DIST=$SCRIPT_DIR/dist

if [ ! -d "$DIST" ]; then
    echo "$DIST not found — goreleaser must run before this script" >&2
    exit 1
fi

PLATFORMS="darwin-arm64 darwin-amd64 linux-amd64 linux-arm64"

# 1. Stamp version into every package.json (the main package + 4
#    sub-packages). Uses Node.js for portable JSON edits so we don't
#    rely on jq being installed everywhere.
update_version() {
    pkg=$1
    node -e "
        const fs = require('fs');
        const p = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
        p.version = '$VERSION';
        if (p.optionalDependencies) {
            for (const k of Object.keys(p.optionalDependencies)) {
                p.optionalDependencies[k] = '$VERSION';
            }
        }
        fs.writeFileSync('$pkg', JSON.stringify(p, null, 2) + '\n');
    "
}

update_version "$NPM_ROOT/prosa/package.json"
for p in $PLATFORMS; do
    update_version "$NPM_ROOT/prosa-$p/package.json"
done

# 2. Copy the matching binary into each platform package.
#    Goreleaser dist layout: dist/prosa_<os>_<arch>(_<microarch>)/prosa
for p in $PLATFORMS; do
    os=${p%-*}
    arch=${p#*-}
    src=$(find "$DIST" -path "*/prosa_${os}_${arch}*/prosa" -type f | head -n 1)
    if [ -z "$src" ]; then
        echo "missing dist artifact for $p" >&2
        exit 1
    fi
    dst=$NPM_ROOT/prosa-$p/bin/prosa
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod 0755 "$dst"
done

# 3. Pre-flight: every package.json shares the exact same version.
#    A divergent main package vs. sub-package version makes
#    optionalDependencies resolve to nothing.
for pkg in "$NPM_ROOT/prosa/package.json" \
           "$NPM_ROOT/prosa-darwin-arm64/package.json" \
           "$NPM_ROOT/prosa-darwin-amd64/package.json" \
           "$NPM_ROOT/prosa-linux-amd64/package.json" \
           "$NPM_ROOT/prosa-linux-arm64/package.json"; do
    actual=$(node -e "console.log(require('$pkg').version)")
    if [ "$actual" != "$VERSION" ]; then
        echo "version mismatch in $pkg: $actual != $VERSION" >&2
        exit 1
    fi
done

# 4. Publish sub-packages first, then the main package. If the main
#    one published before the sub-packages were live, npm would
#    install @c3-oss/prosa with unresolved optionalDependencies and
#    the shim would fail at runtime.
for p in $PLATFORMS; do
    (cd "$NPM_ROOT/prosa-$p" && npm publish --access public)
done
(cd "$NPM_ROOT/prosa" && npm publish --access public)

echo "published @c3-oss/prosa@$VERSION + 4 platform sub-packages"
