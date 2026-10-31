/**
 * Source-free view of one current app agent assembly. The application boundary
 * passes the same agent that supplied the final tools to the adopted registry.
 */
export type TurnPromptSource = {
  readonly instructions: string;
  readonly resolveInstructionsForRequest?: () => string;
  readonly tools: readonly { readonly name: string }[];
};

export type TurnPrompt = {
  readonly instructions: string;
  readonly toolNames: readonly string[];
};

/**
 * Project one current assembly into plain TurnInput data. Call at each model
 * request boundary so request-time context stays current; do not cache the
 * result across requests or combine fields from different agent generations.
 */
export function turnPrompt(source: TurnPromptSource): TurnPrompt {
  return {
    instructions: source.resolveInstructionsForRequest?.() ?? source.instructions,
    toolNames: source.tools.map((tool) => tool.name),
  };
}
