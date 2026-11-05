---
"@acp-ferry/broker": minor
---

Add `redact`, which replaces credential-shaped text in a session export with `[redacted:<kind>]` and reports the kinds and counts it replaced, never the values. It covers known token prefixes, PEM private keys, JSON Web Tokens, `Authorization` header values, passwords in URLs, and assignments whose name holds a credential word. Add `isSensitivePath`, which names files whose content an export never carries, such as `.env` and SSH private keys. Add `redactionLosses` and `mergeRedactionFindings`, which turn findings into a `losses` line. Redaction is pattern-based, so read an export before you share it. ([#9](https://github.com/aelmanaa/acp-ferry/issues/9))
