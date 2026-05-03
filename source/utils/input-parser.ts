/**
 * Pure function to parse slash commands from user input.
 */
export type ParsedInput =
  | { type: 'slash-command'; commandName: string; args: string }
  | { type: 'message'; text: string };

export function parseInput(value: string): ParsedInput {
  if (!value.startsWith('/')) {
    return { type: 'message', text: value };
  }

  const commandLine = value.slice(1); // Remove leading '/'
  const [commandName, ...argsParts] = commandLine.split(/\s+/);
  const args = argsParts.join(' ');

  return { type: 'slash-command', commandName, args };
}
