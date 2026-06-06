# Install

prosa ships through four channels. All of them produce the same binary —
pick the one that fits your platform and tooling.

| Channel | Command | Notes |
| --- | --- | --- |
| Homebrew (macOS) | `brew install c3-oss/prosa/prosa` | Auto-updates with `brew upgrade`. CLI-only cask. |
| Shell installer (Linux + macOS) | `curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh \| sh` | sha256-verified. Installs `prosa` into `~/.local/bin` by default. |
| npm (anywhere with Node ≥ 22) | `npm install -g @c3-oss/prosa` | Platform binary chosen via `optionalDependencies`. |
| Source | `just build` (inside `devbox shell`) | See [contributing.md](contributing.md). |

After install, run **`prosa setup`** once. It walks through device auth,
detects local agent histories, installs the scheduled-sync job, and runs the
first scan.

## Homebrew

```sh
brew install c3-oss/prosa/prosa
```

`c3-oss/prosa` is shorthand for the tap repo
[`c3-oss/homebrew-prosa`](https://github.com/c3-oss/homebrew-prosa). The cask
publishes one binary cask at a time (`prosa`, `prosa-server`,
`prosa-panel`) into the Homebrew prefix. GoReleaser updates the casks
on every tag push — there is no manual step.

To upgrade:

```sh
brew upgrade prosa
```

To remove:

```sh
brew uninstall prosa
brew untap c3-oss/prosa
```

## Shell installer (`install.sh`)

```sh
curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
```

`install.sh` is a POSIX script with no external dependencies beyond `curl`
and either `sha256sum` or `shasum -a 256`. It:

1. Detects OS and arch (Linux/Darwin × amd64/arm64).
2. Resolves the version (`PROSA_VERSION` if set, otherwise latest from the
   GitHub releases API).
3. Downloads the tarball and `checksums.txt`.
4. Verifies sha256.
5. Installs the binaries into `INSTALL_DIR` (default `~/.local/bin`).

### Environment overrides

| Variable | Default | What it does |
| --- | --- | --- |
| `PROSA_VERSION` | `latest` | Pin to a specific tag (e.g. `v0.15.2`). |
| `INSTALL_DIR` | `$HOME/.local/bin` | Where binaries land. Created if missing. |
| `INSTALL_BINS` | `prosa` | Space-separated list. Use `"prosa prosa-server prosa-panel"` to install all three. |

Examples:

```sh
# Install a specific version
PROSA_VERSION=v0.15.2 curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh

# Install all three binaries to /usr/local/bin
INSTALL_DIR=/usr/local/bin INSTALL_BINS="prosa prosa-server prosa-panel" \
  curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh
```

If `INSTALL_DIR` is not already on your `PATH`, the script prints the export
line you need to add to your shell rc.

## npm

```sh
npm install -g @c3-oss/prosa
```

The `@c3-oss/prosa` package is a thin metapackage. At install time, npm
resolves the right platform-specific sub-package
(`@c3-oss/prosa-{darwin,linux}-{arm64,amd64}`) via `optionalDependencies`.

The bin shim (`bin/prosa.js`) spawns the matching native binary with full
argv passthrough and signal forwarding. There is no postinstall download
step.

Supported platforms: macOS arm64, macOS amd64, Linux amd64, Linux arm64.
Anything else errors out with a clear message.

Requires Node.js 22+.

To upgrade:

```sh
npm install -g @c3-oss/prosa@latest
```

Implementation detail and publishing flow:
[distribution/npm.md](distribution/npm.md).

## From source

The full developer workflow lives in [contributing.md](contributing.md). The
short version:

```sh
git clone https://github.com/c3-oss/prosa.git
cd prosa
devbox shell        # pinned toolchain
just build          # builds bin/prosa, bin/prosa-server, bin/prosa-panel
./bin/prosa --version
```

The toolchain (Go, buf, gofumpt, golangci-lint, just, node) is pinned in
[`../devbox.json`](../devbox.json). You don't need to install any of it
manually.

## Verifying the install

Regardless of channel:

```sh
prosa --version    # prints version, commit, build date
prosa --help       # subcommand summary
```

If `prosa --version` works but you see "command not found" otherwise, your
`PATH` probably doesn't include the install directory. The shell installer
prints the export line for you; for Homebrew and npm, the global path should
already be on `PATH`.

## Where data lives

After `prosa setup`:

- **Store**: `~/.local/share/prosa/store.db` (SQLite).
- **Raw transcripts**: `~/.local/share/prosa/raw/<agent>/<YYYY>/<MM>/<session-id>.jsonl`.
- **Auth token**: `~/.config/prosa/auth.json`.

Override with `PROSA_HOME` (data) or standard `XDG_*` env vars.

The full layout is documented in
[`architecture/store.md`](architecture/store.md).

## Uninstall

```sh
# Homebrew
brew uninstall prosa
brew untap c3-oss/prosa

# Shell installer / source
rm -- "$HOME/.local/bin/prosa"
rm -- "$HOME/.local/bin/prosa-server"  # if installed
rm -- "$HOME/.local/bin/prosa-panel"   # if installed

# npm
npm uninstall -g @c3-oss/prosa

# Scheduled sync job
prosa schedule uninstall    # before removing the binary, ideally

# Data (destructive — keeps no backup)
rm -rf -- "$HOME/.local/share/prosa" "$HOME/.config/prosa"
```
