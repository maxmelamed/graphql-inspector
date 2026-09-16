---
'@graphql-inspector/action': minor
---

Adds an optional `annotation-level` input to filter inline GitHub Action annotations by minimum
severity. Choose `warning` for breaking and dangerous changes or `failure` for breaking changes
only. The default `notice` preserves all annotations. Filtering does not affect the check summary,
change count, or conclusion.
