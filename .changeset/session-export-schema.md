---
"@acp-ferry/spec": minor
---

Add the JSON Schema of `SessionExport` version 0 as `@acp-ferry/spec/session-export.schema.json` and as the `sessionExportSchema` constant. Add `parseSessionExport`, which checks an unknown value against the schema rules and size limits without a dependency. Its error names the JSON path of the first bad field. Add `SESSION_EXPORT_LIMITS` with the limits. [#8](https://github.com/aelmanaa/acp-ferry/issues/8)
