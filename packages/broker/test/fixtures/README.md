# Test fixtures

Scripts for the fake ACP agent (`../support/fake-acp-agent.ts`). Each `.jsonl` file starts with a
header line, then lists the messages the fake agent expects (`recv`) and sends (`send`).

| File                                           | Adapter                  | How it was made                                 |
| ---------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `claude-agent-acp/2026-11-05-prompt.jsonl`     | claude-agent-acp 0.101.0 | Constructed from the source at commit `85aec26` |
| `claude-agent-acp/2026-11-05-rate-limit.jsonl` | claude-agent-acp 0.101.0 | Constructed from the source at commit `85aec26` |
| `codex-acp/2026-11-05-prompt.jsonl`            | codex-acp 2.5.0          | Constructed from the source at commit `34e0897` |
| `codex-acp/2026-11-05-usage-limit.jsonl`       | codex-acp 2.5.0          | Constructed from the source at commit `34e0897` |

None of these were recorded from a live run: unit tests never start a real agent, and the live run
belongs to #17. The message shapes follow [Adapters](../../../../docs/contributor/adapters.md). The
model values, session ids, texts and numbers are invented. Replace each file with a redacted
recording of one real run when #17 records one, and update this table with the adapter version.
