#!/usr/bin/env node
// @c3-oss/prosa CLI shim.
//
// At install time npm picks the @c3-oss/prosa-<platform>-<arch>
// optionalDependency that matches the user's machine and skips
// the others. This script resolves whichever sub-package landed
// and runs its binary as a child process with the same argv.
//
// Signals (SIGINT/SIGTERM/SIGHUP) are explicitly forwarded so a
// Ctrl+C at the npm wrapper level reaches the Go binary instead of
// leaving an orphan; the exit code or terminating signal is then
// re-raised on this process so the parent shell still sees a
// faithful exit status.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const subpkg = `@c3-oss/prosa-${process.platform}-${process.arch}`;

let binary;
try {
  binary = require.resolve(`${subpkg}/bin/prosa`);
} catch {
  console.error(
    `prosa: no binary for ${process.platform}/${process.arch}.\n` +
      `Expected optionalDependency ${subpkg} to be installed.\n` +
      `Supported platforms: darwin-arm64, darwin-amd64, linux-amd64, linux-arm64.`,
  );
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
