#!/bin/sh
# install.sh — POSIX installer for prosa.
#
# This script:
#   1. Detects your OS (Linux or Darwin) and CPU arch (amd64 or arm64).
#   2. Resolves the latest prosa release from GitHub (or honors PROSA_VERSION).
#   3. Downloads the per-platform release tarball plus checksums.txt.
#   4. Verifies the release tarball sha256 before writing anything to disk.
#   5. Installs the prosa binary (and optionally prosa-server / prosa-panel)
#      into $INSTALL_DIR (default ~/.local/bin).
#
# Run as:
#   curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
#
# Env overrides:
#   PROSA_VERSION   pin to a specific tag, e.g. v0.11.0; skips the GH API lookup
#   INSTALL_DIR     where to drop the binaries (default ~/.local/bin)
#   INSTALL_BINS    space-separated binaries to install. When unset, the
#                   script prompts on a tty (CLI / all / server / panel)
#                   and falls back to "prosa" in non-interactive runs.
#                   Full set: "prosa prosa-server prosa-panel".

set -eu

REPO="c3-oss/prosa"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

err() {
    printf '%s\n' "error: $*" >&2
    exit 1
}

info() {
    printf '%s\n' "$*" >&2
}

require_cmd() {
    for c in "$@"; do
        if ! command -v "$c" >/dev/null 2>&1; then
            err "$c is required but not found in PATH"
        fi
    done
}

detect_platform() {
    case "$(uname -s)" in
        Linux)  OS=linux ;;
        Darwin) OS=darwin ;;
        *) err "unsupported OS: $(uname -s)" ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) ARCH=amd64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) err "unsupported arch: $(uname -m)" ;;
    esac
}

resolve_version() {
    if [ -n "${PROSA_VERSION:-}" ]; then
        VERSION="$PROSA_VERSION"
        return
    fi
    require_cmd curl
    info "resolving latest release from github.com/$REPO ..."
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1)
    if [ -z "$VERSION" ]; then
        err "could not resolve latest release; set PROSA_VERSION=vX.Y.Z and retry"
    fi
}

sha256_verify() {
    # $1 = path to file, $2 = expected sha256
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$1" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$1" | awk '{print $1}')
    else
        err "no sha256 tool found (need sha256sum or shasum)"
    fi
    if [ "$actual" != "$2" ]; then
        err "checksum mismatch: expected $2, got $actual"
    fi
}

choose_bins() {
    # INSTALL_BINS env wins (script mode, CI, repeat installs).
    if [ -n "${INSTALL_BINS:-}" ]; then
        return
    fi
    # No env and no controlling terminal → conservative default.
    if [ ! -r /dev/tty ]; then
        INSTALL_BINS="prosa"
        return
    fi
    printf '\nprosa ships three binaries. Which would you like to install?\n' >&2
    printf '  1) prosa             CLI only (default)\n' >&2
    printf '  2) all three         prosa + prosa-server + prosa-panel\n' >&2
    printf '  3) prosa-server      sync host only\n' >&2
    printf '  4) prosa-panel       web UI host only\n' >&2
    printf '\nChoice [1]: ' >&2
    choice=""
    read -r choice </dev/tty || choice=""
    case "${choice:-1}" in
        2) INSTALL_BINS="prosa prosa-server prosa-panel" ;;
        3) INSTALL_BINS="prosa-server" ;;
        4) INSTALL_BINS="prosa-panel" ;;
        *) INSTALL_BINS="prosa" ;;
    esac
}

main() {
    detect_platform
    choose_bins
    resolve_version
    require_cmd curl

    # Strip leading 'v' for asset-name matching.
    semver=${VERSION#v}
    base="https://github.com/$REPO/releases/download/$VERSION"

    tmp=$(mktemp -d -t prosa-install.XXXXXX 2>/dev/null \
          || mktemp -d "${TMPDIR:-/tmp}/prosa-install.XXXXXX")
    # shellcheck disable=SC2064  # expand $tmp at trap-registration time
    trap "rm -rf '$tmp'" EXIT INT TERM

    require_cmd tar
    curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"

    mkdir -p "$INSTALL_DIR"

    asset="prosa_${semver}_${OS}_${ARCH}.tar.gz"
    info "downloading $asset ..."
    curl -fsSL -o "$tmp/$asset" "$base/$asset"

    expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/checksums.txt")
    if [ -z "$expected" ]; then
        err "could not find $asset in checksums.txt"
    fi
    sha256_verify "$tmp/$asset" "$expected"

    unpack="$tmp/unpacked"
    mkdir -p "$unpack"
    tar -xzf "$tmp/$asset" -C "$unpack"

    for bin in $INSTALL_BINS; do
        src="$unpack/$bin"
        if [ ! -f "$src" ]; then
            err "could not find $bin in $asset"
        fi

        install -m 0755 "$src" "$INSTALL_DIR/$bin"
        info "installed $bin -> $INSTALL_DIR/$bin"
    done

    info ""
    info "prosa $VERSION installed."
    info "next: run 'prosa setup'"
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            info ""
            info "warning: $INSTALL_DIR is not in your PATH."
            info "add this to your shell rc:"
            info "  export PATH=\"$INSTALL_DIR:\$PATH\""
            ;;
    esac
}

main "$@"
