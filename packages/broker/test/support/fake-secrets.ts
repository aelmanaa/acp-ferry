// Obviously fake credentials, assembled at run time so that no credential-shaped string appears in
// the repository. Each body is a repeated "FAKE" filler; none of them is a real key.

/** Joins parts, so that a credential prefix never appears whole in the source. */
export function join(...parts: string[]): string {
  return parts.join("");
}

/** Joins a prefix and a filler of the given length, for example `fake("ghp_", 36)`. */
export function fake(prefix: string, length: number, filler = "FAKE"): string {
  return prefix + filler.repeat(Math.ceil(length / filler.length)).slice(0, length);
}

type Kind =
  | "anthropic"
  | "openai"
  | "github"
  | "githubPat"
  | "gitlab"
  | "slack"
  | "aws"
  | "google"
  | "npm"
  | "jwt";

/** Makers for each fake credential; `pem` takes the key type, for example `"RSA "` or `""`. */
export const FAKE: Readonly<Record<Kind, () => string>> & {
  readonly pem: (kind?: string) => string;
} = {
  anthropic: () => fake(["sk", "ant", "api03", ""].join("-"), 40, "Fake0"),
  openai: () => fake(["sk", "proj", ""].join("-"), 40, "Fake0"),
  github: () => fake(["gh", "p_"].join(""), 36, "Fake0"),
  githubPat: () => fake(["github", "pat", ""].join("_"), 40, "Fake0"),
  gitlab: () => fake(["gl", "pat-"].join(""), 20, "Fake0"),
  slack: () => fake(["xo", "xb-"].join(""), 24, "0000-Fake-"),
  aws: () => fake(["AK", "IA"].join(""), 16, "FAKE"),
  google: () => fake(["AI", "za"].join(""), 35, "Fake_"),
  npm: () => fake(["np", "m_"].join(""), 36, "Fake0"),
  jwt: () =>
    [
      fake(join("ey", "J"), 12, "Fake"),
      fake(join("ey", "J"), 16, "Fake"),
      fake("", 16, "Fake"),
    ].join("."),
  pem: (kind = "RSA ") =>
    [
      `-----BEGIN ${kind}PRIVATE KEY-----`,
      fake("", 64, "FAKE"),
      fake("", 64, "FAKE"),
      `-----END ${kind}PRIVATE KEY-----`,
    ].join("\n"),
};
