#!/usr/bin/env node
"use strict";

// @c3-oss/prosa CLI shim.
//
// At install time npm picks the @c3-oss/prosa-<platform>-<arch>
// optionalDependency that matches the user's machine and skips the
// others. This script resolves whichever sub-package landed and
// exec's its binary with the same argv. No network calls, no
// postinstall.

const { execFileSync } = require("node:child_process");

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

try {
  execFileSync(binary, process.argv.slice(2), { stdio: "inherit" });
} catch (err) {
  process.exit(typeof err.status === "number" ? err.status : 1);
}
