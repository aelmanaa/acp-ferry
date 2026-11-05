# Claude Code transcript fixtures

Synthetic transcripts for the Claude Code reader (#11). Each file is written by hand in the record
shape of Claude Code 2.1.318, checked on 2026-11-05 (see
[adapters.md](../../../../../docs/contributor/adapters.md)). No line comes from a real session.

- Session id `5e551011-0000-4000-8000-000000000001`; record ids are fixed UUIDs.
- Paths use `/home/user/demo`. No credential-shaped string appears; tests that need one build it at
  run time from `test/support/fake-secrets.ts`.
- `MARKER-…` strings are planted in records the reader must drop. Tests check that no marker reaches
  the export.

| File                              | Case                                                                           | Claude Code |
| --------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| `2026-11-05-plain-chat.jsonl`     | Prompts and replies, thinking, an image, meta and non-conversation records     | 2.1.318     |
| `2026-11-05-tool-calls.jsonl`     | Tool calls: success, failure, parallel calls, no result, image, sensitive file | 2.1.318     |
| `2026-11-05-todo-list.jsonl`      | `TodoWrite` lists, one rejected                                                | 2.1.318     |
| `2026-11-05-task-list.jsonl`      | `TaskCreate` and `TaskUpdate`                                                  | 2.1.318     |
| `2026-11-05-compaction.jsonl`     | A compaction boundary and its summary                                          | 2.1.318     |
| `2026-11-05-rewound-branch.jsonl` | A rewound prompt whose branch is abandoned                                     | 2.1.318     |
| `2026-11-05-subagent.jsonl`       | An `Agent` call and a sidechain record                                         | 2.1.318     |
| `2026-11-05-malformed-line.jsonl` | Lines that are not JSON, have no type or have no uuid                          | 2.1.318     |
| `2026-11-05-continued-in.jsonl`   | A `continued-in` record                                                        | 2.1.318     |
