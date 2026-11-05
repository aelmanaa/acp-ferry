// Runs `node --test` for the `test:unit` and `test:integration` scripts of the packages, with a
// `--test-timeout` value that depends on the Node version, because the flag changed its meaning:
//
// - On Node 24 and later it limits each test, and a file may run as long as its tests need.
// - On Node 22 it limits each test file and sets no limit per test. The runner ends a file that
//   runs longer with SIGTERM, even when every test in it passes.
//
// Node changed this in nodejs/node#57672, first released in 24.0.0; the 22.x line does not have the
// change. So on Node 24 and later this script passes the per-test limit, and on Node 22 a file
// budget: large enough for a file whose tests all pass on a loaded machine, and still an end for a
// file that hangs. On Node 22 no test has a limit from the flag; a test's own `timeout` option and
// any limit a test sets itself still applies. When the Node floor moves to a release that has
// the change, delete the file budgets and this script, and put `--test-timeout` back in the package
// scripts.
//
// Usage: node scripts/node-test.ts unit|integration [node --test arguments and files]
import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The two values `--test-timeout` can get, in milliseconds. */
export interface TestLimits {
  /** The limit of one test, passed on Node 24 and later. */
  perTestMs: number;
  /** The limit of one test file, passed on Node 22. */
  fileBudgetMs: number;
}

/** The limits of each kind of test this script runs. */
export const LIMITS: Readonly<Record<string, TestLimits>> = {
  unit: { perTestMs: 30_000, fileBudgetMs: 300_000 },
  integration: { perTestMs: 120_000, fileBudgetMs: 600_000 },
};

/** The first Node major on which `--test-timeout` limits each test and not each file. */
export const PER_TEST_SINCE_MAJOR = 24;

/** The major of a Node version such as `22.13.0`. */
export function nodeMajor(version: string = process.versions.node): number {
  return Number(version.split(".")[0]);
}

/** The `--test-timeout` value for a Node major: the per-test limit, or the file budget before 24. */
export function testTimeoutMs(major: number, limits: TestLimits): number {
  return major >= PER_TEST_SINCE_MAJOR ? limits.perTestMs : limits.fileBudgetMs;
}

/** Starts `node --test` on this Node with the `--test-timeout` value for it, then `args`. */
export function startNodeTest(
  limits: TestLimits,
  args: readonly string[],
  options: { stdio?: StdioOptions; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const timeout = testTimeoutMs(nodeMajor(), limits);
  return spawn(process.execPath, ["--test", `--test-timeout=${timeout}`, ...args], {
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
  });
}

/** The signals passed on to `node --test`, which ends the test files. */
const FORWARDED: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

function main(argv: readonly string[]): void {
  const [kind, ...args] = argv;
  const limits = kind === undefined ? undefined : LIMITS[kind];
  if (limits === undefined) {
    process.stderr.write(
      `Usage: node scripts/node-test.ts ${Object.keys(LIMITS).join("|")} [node --test arguments and files]\n`,
    );
    process.exitCode = 2;
    return;
  }
  const child = startNodeTest(limits, args);
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED) {
    process.on(signal, forward);
  }
  child.on("error", (error) => {
    process.stderr.write(`node-test: cannot start node --test: ${error.message}\n`);
    process.exitCode = 1;
  });
  // This process ends the way the child ended: with its exit code, or by the signal that ended it.
  child.on("close", (code, signal) => {
    for (const forwarded of FORWARDED) {
      process.off(forwarded, forward);
    }
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
