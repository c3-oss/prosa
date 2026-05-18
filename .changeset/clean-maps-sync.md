---
"@c3-oss/prosa": patch
---

Fix chunked sync when remote PostgreSQL projections contain NUL bytes and avoid retrying structured commit errors that are not transient.
