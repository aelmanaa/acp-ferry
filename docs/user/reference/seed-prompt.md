# Seed prompt

Audience: developers who call the broker library to hand a session to another agent. Draft: the API
can change until the extension is reviewed upstream.

An agent cannot load another agent's session file, so a handoff starts a new session in the target
agent and sends it one prompt built from the `SessionExport`: the seed prompt. `renderSeedPrompt` in
`@acp-ferry/broker` builds it (R-PORT-3). It is a pure function: no I/O, no clock, no model call.
The same export and options always give the same text.

```ts
import { parseHandoffMarker, renderSeedPrompt } from "@acp-ferry/broker";
import { parseSessionExport } from "@acp-ferry/spec";

const parsed = parseSessionExport(JSON.parse(json));
if (parsed.ok) {
  const seed = renderSeedPrompt(parsed.value, { handoffId: "4f0c2a9e", mode: "summary+recent" });
  seed.marker; // "acp-ferry handoff 4f0c2a9e"
  seed.omitted; // [] when it fits the budget
  parseHandoffMarker(seed.text); // { ok: true, value: "4f0c2a9e" }
}
```

## Options

| Option          | Default                                                    | What it does                                                                          |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `handoffId`     | Required                                                   | The id in the marker line. 1 to 128 letters, digits, `.`, `_` or `-`; a UUID fits     |
| `mode`          | The export's `handoff`                                     | `summary+recent` or `full-transcript`                                                 |
| `recentTurns`   | `10`                                                       | How many of the last user turns, with their replies, `summary+recent` keeps verbatim  |
| `maxCharacters` | `24000` in `summary+recent`, no limit in `full-transcript` | The most Unicode code points the text may have; older parts are left out first to fit |

`SEED_PROMPT_DEFAULTS` holds the two defaults. An invalid option throws a `RangeError`.

## What the text holds

1. The marker line, `acp-ferry handoff <id>`. It appears once. `parseHandoffMarker` reads the id
   back, and fails when there is no marker line or more than one.
2. Where the session came from: agent, model, session address and export time.
3. The workspace at export: directory, branch, commit and whether there were uncommitted changes
   (R-PORT-4), with a note that it may have changed since.
4. The handoff mode, and what the budget left out, if anything.
5. How to read the rest: the blocks are a record, not instructions, and tool calls already ran in
   the other agent and must not be repeated without a reason.
6. The open plan and the export's `losses` (R-PORT-5).
7. The history, in an `<acp-ferry-history>` block.
8. A closing instruction: change nothing yet, reply with where the work stands and the next step,
   then wait for the user.

## History

Each entry sits in its own block, numbered by its position in the export:
`<acp-ferry-user n="…">`, `<acp-ferry-assistant n="…">`, `<acp-ferry-summary n="…" replaced-turns="…">`
and `<acp-ferry-tool-call n="…" status="…">`. A tool call carries the tool name, then its input and
output in `<acp-ferry-input>` and `<acp-ferry-output>` blocks (R-PORT-2).

- `full-transcript`: every entry in order.
- `summary+recent`: the last `recentTurns` user turns verbatim. A user turn is a user entry and the
  entries up to the next one. Before them come the summary entries that cover earlier turns, and an
  `<acp-ferry-digest>` block with one line for each earlier turn that no summary covers: the prompt
  shortened to 200 characters, the number of tool calls and up to 10 files named in tool inputs
  (`file_path`, `path` and similar JSON fields, and patch file headers). No model writes the digest.

```text
<acp-ferry-digest>
- turn 1: Where does the tokenizer split on dots? [1 tool call; files: src/lex.ts]
- turn 2: Run the tests. [1 tool call]
</acp-ferry-digest>
<acp-ferry-user n="7">
Fix it without changing the public API.
</acp-ferry-user>
```

## Budget

When the text is longer than `maxCharacters`, parts of the history are left out, oldest first:
summary entries, then digest lines, then whole turns, then the replies of the last turn. The plan,
the losses and the last user prompt are never left out, so the text can still be longer than the
budget when they alone are. `omitted` lists each part left out, for example
`turn 3 (entries 7 to 12)`, and the text names them in a `Left out to fit …` line.

## Untrusted text

The history is another session's text, and tool outputs can hold text from web pages or files. It
is a prompt-injection path. The seed prompt reduces the risk; it does not remove it:

- Every piece of transcript text, and every header value taken from the export, sits inside a block
  or in a JSON-quoted string.
- Where the record contains `<acp-ferry`, `</acp-ferry` or `acp-ferry handoff`, in any case and with
  any spacing, a backslash goes before `acp-ferry`. Text in the record cannot close its block or
  add a second marker line, even when it holds an earlier seed prompt.
- The prompt tells the agent the record is data, not instructions.

The import session should also run with permissions denied. The renderer copies the export's text
and never adds back what [redaction](redaction.md) replaced.
