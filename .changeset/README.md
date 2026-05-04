# Changesets

This folder is managed by `@changesets/cli`.

Use changesets to describe package changes that should become npm releases.

```bash
just changeset
just version-packages
just release
```

`just release` publishes to the official npm registry using the package
`publishConfig`.
