/**
 * Finds the model config option of an ACP session and maps a model id to one of its values.
 * Pure functions; no I/O.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/**
 * One model an agent offers in its `category: "model"` config option.
 *
 * @experimental
 */
export interface ModelChoice {
  /** The option value to send in `session/set_config_option`. */
  readonly value: string;
  /** The display name the agent gives. */
  readonly name: string;
}

/**
 * The model config option of a session.
 *
 * @experimental
 */
export interface ModelOption {
  /** The config option id, for `session/set_config_option`. */
  readonly configId: string;
  /** The value in use. */
  readonly currentValue: string;
  /** Every model the agent offers, groups flattened, in the agent's order. */
  readonly choices: readonly ModelChoice[];
}

/**
 * Finds the first `select` config option with `category: "model"`.
 *
 * @param options - The `configOptions` of a session, as the agent last sent them.
 * @returns The option, or `undefined` when the agent offers no model choice.
 * @example
 * ```ts
 * const option = findModelOption(session.configOptions);
 * option?.choices.map((choice) => choice.value); // ["default", "opus", "sonnet"]
 * ```
 * @experimental
 */
export function findModelOption(options: readonly SessionConfigOption[]): ModelOption | undefined {
  for (const option of options) {
    if (option.category === "model" && option.type === "select") {
      const choices: ModelChoice[] = [];
      for (const entry of option.options) {
        const items = "group" in entry ? entry.options : [entry];
        for (const item of items) {
          choices.push({ value: item.value, name: item.name });
        }
      }
      return { configId: option.id, currentValue: option.currentValue, choices };
    }
  }
  return undefined;
}

/**
 * Maps a model id to an option value: an exact match on the value first, then a match on the part
 * after the first `/` of a `provider/model` id (R-ID-2).
 *
 * @param choices - The models the agent offers.
 * @param model - An option value, or a `provider/model` id such as `anthropic/opus`.
 * @returns The option value, or `undefined` when nothing matches.
 * @example
 * ```ts
 * resolveModelValue([{ value: "opus", name: "Opus" }], "anthropic/opus"); // "opus"
 * ```
 * @experimental
 */
export function resolveModelValue(
  choices: readonly ModelChoice[],
  model: string,
): string | undefined {
  const exact = choices.find((choice) => choice.value === model);
  if (exact !== undefined) {
    return exact.value;
  }
  const slash = model.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  const rest = model.slice(slash + 1);
  return choices.find((choice) => choice.value === rest)?.value;
}
