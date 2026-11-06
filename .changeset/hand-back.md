---
"@acp-ferry/broker": minor
---

Add `handBack`, which moves a session back to the agent it came from and appends only the turns added since the handoff. It reads the moved session, finds the new turns after the seed prompt's reply or after the last hand-back, and checks that the original session still has exactly the entries recorded at handoff. If anything differs, it stops with a `HandBackError` such as `prefix-mismatch`, sends nothing and writes nothing. Otherwise it resumes the original session over ACP, with `session/load` when resume is not offered, sends one prompt with the new turns, and appends a `handback` line to the ledger. A second hand-back of the same pair checks against the new state. `handOff` now records the source `basis` in the export and as `sourceBasis` in the ledger. `readLedger` returns both `handoff` and `handback` lines. Add `renderHandBackPrompt`, and `--back` to the example script. ([#16](https://github.com/aelmanaa/acp-ferry/issues/16))
