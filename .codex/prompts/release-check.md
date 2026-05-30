# Prosa Release Check Prompt

Use this prompt before cutting a `v*` tag.

1. Run `just ci`.
2. Run `just snapshot`.
3. Build the local image with `docker build -t prosa:local .`.
4. Verify `./bin/prosa --version` prints the expected build metadata in a
   release build or `dev` metadata locally.
5. Confirm release targets remain macOS/Linux `amd64`/`arm64` unless
   `INTENT.md` changes.

Report any dirty generated files, release artifacts that do not include all
three binaries, or Docker entrypoint drift away from `prosa-server`.
