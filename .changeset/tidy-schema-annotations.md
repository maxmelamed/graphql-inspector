---
'@graphql-inspector/action': minor
---

Adds an optional `annotation-level` input to filter inline GitHub Action annotations by minimum
severity. Choose `dangerous` for breaking and dangerous changes or `breaking` for breaking changes
only. The default `all` preserves all annotations. Filtering does not affect the check summary,
change count, or conclusion.
