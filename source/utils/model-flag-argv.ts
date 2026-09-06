const MODEL_FLAG_TOKENS = new Set(['--model', '-m']);

/**
 * meow's underlying parser greedily consumes the token immediately following
 * a string flag as that flag's value — including when that token is the
 * ENTIRE remainder of the command line. For `--model`/`-m` this creates a
 * genuine ambiguity: `term2 -m "explain this"` could mean "set the model to
 * the literal string 'explain this'" or "no model given; run 'explain this'
 * as a prompt". Both readings are indistinguishable from argv shape alone,
 * so a rule has to be picked.
 *
 * The rule: a lone trailing token immediately after `-m`/`--model` — one with
 * nothing else following it on the command line — is treated as a PROMPT,
 * not a model value. `-m`/`--model` takes no value in that shape, so it
 * falls into the same "value-optional" path as a bare `--model` (which opens
 * the interactive picker in an interactive session), and the token is left
 * as a genuine positional. To set a model value in that exact shape, use
 * `=` syntax (`--model=<value>` / `-m=<value>`): the parser binds an `=`
 * value to the flag before positional splitting happens, so it is never
 * ambiguous and is left completely untouched by this function.
 *
 * Every other shape already parses unambiguously and is also left untouched:
 * - `--model` alone, or immediately followed by another flag, already
 *   parses to an empty value with nothing swallowed;
 * - `--model <value> <prompt...>` (two or more trailing tokens) is
 *   unambiguous: the first token is the value, the rest is the prompt.
 */
export function preprocessArgvForOptionalModelFlag(argv: readonly string[]): string[] {
  const result = [...argv];
  for (let i = 0; i < result.length; i++) {
    const token = result[i];
    if (!MODEL_FLAG_TOKENS.has(token)) continue;

    // Only the flag's LAST occurrence, immediately followed by exactly one
    // more token and nothing else, is ambiguous.
    const isSecondToLast = i === result.length - 2;
    if (!isSecondToLast) continue;

    const next = result[i + 1];
    if (next === undefined || next.startsWith('-')) continue;

    // Insert an empty value so meow parses the flag as valueless and leaves
    // `next` in place as a positional argument.
    result.splice(i + 1, 0, '');
    i++;
  }
  return result;
}
