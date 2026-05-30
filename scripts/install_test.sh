#!/bin/sh
# install_test.sh — offline smoke checks for install.sh.
#
# Runs sh -n (POSIX syntax) plus dash -n and shellcheck when available.
# Does not execute the installer or hit the network.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
INSTALL=$SCRIPT_DIR/install.sh

if [ ! -f "$INSTALL" ]; then
    echo "missing $INSTALL" >&2
    exit 1
fi

# 1) POSIX syntax check.
sh -n "$INSTALL"
echo "ok: sh -n"

# 2) dash strictness check (POSIX-strict shell) when available.
if command -v dash >/dev/null 2>&1; then
    dash -n "$INSTALL"
    echo "ok: dash -n"
fi

# 3) shellcheck (POSIX dialect) when available.
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck -s sh "$INSTALL"
    echo "ok: shellcheck"
fi

echo "all checks passed"
