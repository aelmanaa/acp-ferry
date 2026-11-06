---
"@acp-ferry/spec": minor
---

Add an optional `basis` field to `SessionExport`: the source session address, the number of transcript entries read and a SHA-256 digest of them. `parseSessionExport` and the JSON Schema check it. Add `digestEntries` and `computeSessionBasis`, which compute the digest with Web Crypto, and `SESSION_DIGEST_PATTERN`. Add the `SessionBasis` and `SessionDigest` types. ([#16](https://github.com/aelmanaa/acp-ferry/issues/16))
