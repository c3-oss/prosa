---
"@c3-oss/prosa": patch
---

Improve local auth, compile, and sync flows for remote promotion.

`prosa auth login` now works more reliably against the local API, explicit compile stores can be initialized automatically, relative compile source paths resolve from the invoking workspace, and sync can promote larger bundles in chunks while preserving local stores with `--keep-local`.
