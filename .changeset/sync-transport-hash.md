---
"@c3-oss/prosa": patch
"@c3-oss/prosa-core": patch
---

Persist local object transport hashes so repeated sync planning can avoid
rehashing compressed CAS bytes after the first backfill.
