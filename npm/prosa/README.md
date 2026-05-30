# @c3-oss/prosa

Unified history of AI agent sessions across devices.

```sh
npm install -g @c3-oss/prosa
prosa setup
```

`prosa` is a small JavaScript shim that delegates to the prebuilt
Go binary matching your platform, distributed through npm
`optionalDependencies`. There is no `postinstall` download — npm
filters by `os` and `cpu` and only installs the sub-package your
machine needs.

Supported platforms:

- macOS arm64 / amd64
- Linux amd64 / arm64

Source code, documentation, and issue tracker:
<https://github.com/c3-oss/prosa>
