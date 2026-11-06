/**
 * DRAFT. The digest of transcript entries that a round trip checks before it appends to a session
 * (R-PORT-6). It uses Web Crypto only, so it runs in any JavaScript runtime with
 * `globalThis.crypto.subtle`.
 */
import type {
  SessionAddressString,
  SessionBasis,
  SessionDigest,
  TranscriptEntry,
} from "./types.ts";

const DIGEST_PREFIX = "sha256:";

/**
 * The pattern of a {@link SessionDigest}: `sha256:` and 64 lowercase hexadecimal digits. The JSON
 * Schema uses the same pattern.
 *
 * @example
 * ```ts
 * new RegExp(SESSION_DIGEST_PATTERN, "u").test(basis.digest); // true
 * ```
 * @experimental
 */
export const SESSION_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

/**
 * Computes the SHA-256 digest of transcript entries with Web Crypto.
 *
 * The digest covers the UTF-8 bytes of `JSON.stringify` of the array of entries, each rebuilt with
 * its fields in a fixed order: `kind`, `text` for `user` and `assistant`; `kind`, `tool`, `input`,
 * `output`, `status` for `tool-call`; `kind`, `text`, `replacedTurns` for `summary`. Two readings of
 * an unchanged session give the same digest; any change to the text, the order or the number of
 * entries gives another.
 *
 * @param entries - The entries, oldest first.
 * @returns `sha256:` and 64 lowercase hexadecimal digits.
 * @example
 * ```ts
 * await digestEntries([{ kind: "user", text: "Plan the release." }]);
 * // "sha256:5d1c…"
 * ```
 * @experimental
 */
export async function digestEntries(entries: readonly TranscriptEntry[]): Promise<SessionDigest> {
  const text = JSON.stringify(entries.map(canonicalEntry));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"));
  return `${DIGEST_PREFIX}${hex.join("")}`;
}

/**
 * Computes the {@link SessionBasis} of a session from its full reading: the address, the number of
 * entries and their digest.
 *
 * @param address - The session's address.
 * @param entries - Every transcript entry of the reading, oldest first.
 * @returns The basis.
 * @example
 * ```ts
 * const basis = await computeSessionBasis(doc.source.address, doc.entries);
 * basis.entries === doc.entries.length; // true
 * ```
 * @experimental
 */
export async function computeSessionBasis(
  address: SessionAddressString,
  entries: readonly TranscriptEntry[],
): Promise<SessionBasis> {
  return { address, entries: entries.length, digest: await digestEntries(entries) };
}

/** The entry with its fields in the fixed order, and no other field. */
function canonicalEntry(entry: TranscriptEntry): TranscriptEntry {
  if (entry.kind === "tool-call") {
    return {
      kind: entry.kind,
      tool: entry.tool,
      input: entry.input,
      output: entry.output,
      status: entry.status,
    };
  }
  if (entry.kind === "summary") {
    return { kind: entry.kind, text: entry.text, replacedTurns: entry.replacedTurns };
  }
  return { kind: entry.kind, text: entry.text };
}
