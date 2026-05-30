# npm

prosa publishes five packages to the npm registry on every release:

| Package | Role |
| --- | --- |
| `@c3-oss/prosa` | metapackage — what users install |
| `@c3-oss/prosa-darwin-arm64` | platform binary, macOS Apple Silicon |
| `@c3-oss/prosa-darwin-amd64` | platform binary, macOS Intel |
| `@c3-oss/prosa-linux-amd64` | platform binary, Linux x86_64 |
| `@c3-oss/prosa-linux-arm64` | platform binary, Linux ARM64 |

Install command:

```sh
npm install -g @c3-oss/prosa
```

## The optionalDependencies pattern

`@c3-oss/prosa` is a thin metapackage. Its `package.json` declares the four
platform sub-packages as **`optionalDependencies`**:

```json
{
  "name": "@c3-oss/prosa",
  "bin": { "prosa": "bin/prosa.js" },
  "optionalDependencies": {
    "@c3-oss/prosa-darwin-arm64": "VERSION",
    "@c3-oss/prosa-darwin-amd64": "VERSION",
    "@c3-oss/prosa-linux-amd64":  "VERSION",
    "@c3-oss/prosa-linux-arm64":  "VERSION"
  },
  "engines": { "node": ">=22" }
}
```

npm reads each optional dependency's `os` and `cpu` fields and only
installs the one matching the running platform. The other three are
skipped — fast install, small footprint, no postinstall script needed.

Each sub-package looks like:

```json
{
  "name": "@c3-oss/prosa-linux-amd64",
  "os":  ["linux"],
  "cpu": ["x64"],
  "files": ["bin/prosa"],
  "preferUnplugged": true
}
```

`preferUnplugged: true` signals pnpm not to defer extraction — the binary
must be on disk to execute.

## The shim

`@c3-oss/prosa/bin/prosa.js` resolves the platform sub-package and execs
the real binary:

```js
#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');

const platform = process.platform;          // 'darwin' or 'linux'
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const pkg = `@c3-oss/prosa-${platform}-${arch}`;

let binary;
try {
  binary = require.resolve(`${pkg}/bin/prosa`);
} catch {
  console.error(`prosa: no binary for ${platform}-${arch}.`);
  console.error('Supported: darwin-arm64, darwin-amd64, linux-amd64, linux-arm64.');
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
```

Key behaviors:

- Argv passthrough — `prosa search "x"` becomes `prosa search "x"` with no
  wrapper munging.
- Signal forwarding — `Ctrl-C` in your shell propagates to the binary.
- Exit semantics — the shim either re-raises the child's signal or exits
  with the child's code, so shell scripts see the truthful status.

## Publishing pipeline

Lives in `scripts/publish-npm.sh`. Runs from `.github/workflows/release.yml`
after GoReleaser finishes producing artifacts in `dist/`.

```
1. read GITHUB_REF_NAME (e.g. "v0.11.0"), strip leading "v" → "0.11.0"
2. stamp the version into 5 package.json files
3. update optionalDependencies versions in the main package
4. for each platform { darwin-arm64, darwin-amd64, linux-amd64, linux-arm64 }:
     copy dist/prosa_<os>_<arch>/prosa → npm/prosa-<platform>/bin/prosa
     chmod +x
5. verify all five package.json versions match (abort if not)
6. cd into each sub-package and `npm publish --access public`
7. cd into the main package and `npm publish --access public`
```

The script uses Node.js for JSON editing (no `jq` dependency). It exits
non-zero on any sub-step, including version drift.

## Why sub-packages first

If the main `@c3-oss/prosa` publishes before its `optionalDependencies` are
live, npm refuses the resolve and `npm install -g @c3-oss/prosa` fails for
early users. Publishing the sub-packages first guarantees that when the
main package goes live, every optional dep already exists.

## NPM_TOKEN

A granular npm token scoped to the `@c3-oss` org with **publish**
permission. Notes:

- Use a granular token, not a classic one. Scope it as tightly as possible.
- Set automation token (`type: automation`) so 2FA doesn't block CI.
- Stored as the GitHub Actions secret `NPM_TOKEN`.
- The release workflow exports it as `NODE_AUTH_TOKEN` for the `npm
  publish` calls.

## First-time setup of the npm packages

Before the very first release, the five package names must exist on the
registry. Reserve them by publishing a dummy `0.11.0` of each:

```sh
cd npm/prosa-darwin-arm64 && npm publish --access public
cd ../prosa-darwin-amd64  && npm publish --access public
cd ../prosa-linux-amd64   && npm publish --access public
cd ../prosa-linux-arm64   && npm publish --access public
cd ../prosa               && npm publish --access public
```

After that, every `v*` tag re-stamps and re-publishes via the script.

## Verifying

```sh
npm view @c3-oss/prosa version           # last published version
npm view @c3-oss/prosa optionalDependencies
npm install -g @c3-oss/prosa
prosa --version
```

If the install succeeds but `prosa --version` fails with
`no binary for <platform>-<arch>`, your platform isn't in the supported
set. Open an issue with `process.platform` and `process.arch`.

## Uninstall

```sh
npm uninstall -g @c3-oss/prosa
```

The optional dependencies uninstall with it.
