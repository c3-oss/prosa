# Shell installer (`install.sh`)

A POSIX shell script that downloads the right tarball from a GitHub
Release, verifies it, and installs the binaries.

```sh
curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
```

`install.sh` lives at the repo root and is fetched directly from `master`.
Anyone can read it before piping it to `sh`:

```sh
curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh
```

## What it does

1. Detects OS and architecture via `uname`.
2. Resolves the version (`PROSA_VERSION` env, else latest from the GitHub
   releases API).
3. Downloads `prosa_<version>_<os>_<arch>.tar.gz` from the GitHub Release.
4. Downloads `checksums.txt` from the same release.
5. Verifies sha256 using whichever of `sha256sum` or `shasum -a 256` is
   available.
6. Extracts the requested binaries (`INSTALL_BINS`) into `INSTALL_DIR`,
   `chmod 0755`.
7. Prints a short success message. Warns if `INSTALL_DIR` isn't on `PATH`
   and prints the export line to add.

No `sudo`. No global state changes. No background services.

## Supported platforms

- `linux × amd64` (`x86_64`, `amd64` both map to `amd64`)
- `linux × arm64` (`aarch64`, `arm64` both map to `arm64`)
- `darwin × amd64`
- `darwin × arm64`

Anything else exits with `unsupported OS/arch` and the detected `uname`
values.

## Environment overrides

| Variable | Default | What it does |
| --- | --- | --- |
| `PROSA_VERSION` | `latest` | Pin to a specific tag, e.g. `v0.11.0`. Strips the leading `v` for filename matching. |
| `INSTALL_DIR` | `$HOME/.local/bin` | Destination directory. Created if missing. |
| `INSTALL_BINS` | `"prosa"` | Space-separated. Pass `"prosa prosa-server prosa-panel"` to install all three. |

Examples:

```sh
# pin to v0.11.0
PROSA_VERSION=v0.11.0 \
  curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh

# install all three binaries to /usr/local/bin (needs sudo for that path)
INSTALL_DIR=/usr/local/bin INSTALL_BINS="prosa prosa-server prosa-panel" \
  curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sudo -E sh
```

## Source-of-truth contract

The script depends on the release pipeline writing these files to each
GitHub Release, with these exact names:

- `prosa_<version-without-v>_<os>_<arch>.tar.gz`
- `checksums.txt` (lines of `<sha256>  <filename>`)

GoReleaser is configured to produce both. If the archive format ever
changes, `install.sh` and `.goreleaser.yaml` must change together.

## Behavior when things go wrong

- **No internet / 404**: `curl -f` fails fast and the script exits non-zero
  before any file is touched.
- **Checksum mismatch**: the script exits non-zero and removes the
  downloaded tarball. Nothing lands in `INSTALL_DIR`.
- **No `sha256sum` and no `shasum`**: the script exits with a clear
  message. Install one (`apk add coreutils`, `brew install coreutils`,
  etc.) and retry.
- **Binary not in archive** (e.g. `INSTALL_BINS=nope`): the script exits
  after partial extraction. The temp dir is removed.
- **Write permission denied**: the script exits with the filesystem error.
  Re-run with a writable `INSTALL_DIR` or with `sudo`.

The script aims to be re-runnable: if a previous run partially installed,
running it again overwrites cleanly.

## Where it doesn't go

- No scheduled-sync install. That's `prosa schedule install`, which the
  CLI knows how to do platform-correctly.
- No PATH editing. The script tells you what to add; it doesn't touch your
  shell rc.
- No detection of `pkg-config` or system libraries — there are none; the
  binaries are statically linked.

## Changing `install.sh`

The script is small and unit-tested by hand in `prosa-test-runner` on
release-check. Steps when editing:

1. Keep it POSIX shell (not bash-only). Lint with `shellcheck install.sh`.
2. Maintain backwards-compatible env vars. If you remove or rename an env
   var, that's a breaking change for users who already script around it.
3. Test on Linux + macOS, both with `sha256sum` and with `shasum`.
4. Don't add dependencies beyond `curl`, `sha256sum`-or-`shasum`,
   `tar`, `uname`, `mkdir`, `install`, `awk`, `sed`. These are POSIX
   table stakes.
5. Test a `PROSA_VERSION=<old-tag>` install — that's the recovery story
   when a recent release is broken.

A representative session looks like:

```sh
shellcheck install.sh
INSTALL_DIR=$(mktemp -d) sh install.sh
ls -la $INSTALL_DIR
$INSTALL_DIR/prosa --version
```

## Uninstall

The shell installer doesn't track what it wrote. Uninstall is manual:

```sh
rm -- "$HOME/.local/bin/prosa"
rm -- "$HOME/.local/bin/prosa-server"   # if installed
rm -- "$HOME/.local/bin/prosa-panel"    # if installed
```

The data directory and scheduled-sync job are not touched. Use
`prosa schedule uninstall` and `rm -rf -- "$HOME/.local/share/prosa"
"$HOME/.config/prosa"` if you want a full wipe.
