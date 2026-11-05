---
"@acp-ferry/broker": patch
---

`redact` now replaces the whole value of a credential-named key in JSON inside a JSON string, as in a JSONL transcript, when the value holds an escaped quote. Before, the text after the quote stayed in the export. `redact` now replaces a bare `Bearer` token without an `Authorization` header when the token has at least 16 characters and a digit, as kind `authorization-header`. `redact` now checks shell and flag assignments whose name is longer than 128 characters. ([#23](https://github.com/aelmanaa/acp-ferry/issues/23))
