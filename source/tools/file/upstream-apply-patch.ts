/**
 * The model-facing apply_patch contract used by upstream Codex.
 *
 * The executor still consumes the application's operation shape. Keeping this
 * adapter separate means providers that only support JSON function tools can
 * continue using the legacy schema while Responses custom tools receive the
 * exact freeform payload they were trained to emit.
 */

export type UpstreamApplyPatchOperation =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'update_file'; path: string; diff: string; moveTo?: string }
  | { type: 'delete_file'; path: string; diff: string };

export type UpstreamApplyPatchParams = { operations: UpstreamApplyPatchOperation[] };

export const UPSTREAM_APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ENVIRONMENT_ID = '*** Environment ID: ';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';

/** Parse the complete freeform payload into the application's executable shape. */
export function parseUpstreamApplyPatch(input: string): UpstreamApplyPatchParams {
  const lines = normalizePatchLines(input);
  if (lines[0] !== BEGIN_PATCH) throw new Error(`Invalid patch: expected '${BEGIN_PATCH}'.`);
  if (lines[lines.length - 1] !== END_PATCH) throw new Error(`Invalid patch: expected '${END_PATCH}'.`);

  let index = 1;
  if (lines[index]?.startsWith(ENVIRONMENT_ID)) {
    if (!lines[index].slice(ENVIRONMENT_ID.length).trim()) throw new Error('Invalid patch: empty environment ID.');
    index += 1;
  }

  const operations: UpstreamApplyPatchOperation[] = [];
  while (index < lines.length - 1) {
    const header = lines[index];
    if (header.startsWith(ADD_FILE)) {
      const filePath = readPath(header, ADD_FILE);
      index += 1;
      const body: string[] = [];
      while (index < lines.length - 1 && !isOperationHeader(lines[index])) body.push(lines[index++]);
      if (body.length === 0 || body.some((line) => !line.startsWith('+'))) {
        throw new Error(`Invalid Add File section for '${filePath}'.`);
      }
      operations.push({ type: 'create_file', path: filePath, diff: body.join('\n') });
      continue;
    }
    if (header.startsWith(DELETE_FILE)) {
      operations.push({ type: 'delete_file', path: readPath(header, DELETE_FILE), diff: '' });
      index += 1;
      continue;
    }
    if (header.startsWith(UPDATE_FILE)) {
      const filePath = readPath(header, UPDATE_FILE);
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith(MOVE_TO)) {
        moveTo = readPath(lines[index], MOVE_TO);
        index += 1;
      }
      const body: string[] = [];
      while (index < lines.length - 1 && !isOperationHeader(lines[index])) body.push(lines[index++]);
      if (body.length === 0 && !moveTo) throw new Error(`Invalid Update File section for '${filePath}'.`);
      operations.push({ type: 'update_file', path: filePath, diff: body.join('\n'), ...(moveTo ? { moveTo } : {}) });
      continue;
    }
    throw new Error(`Invalid patch line: ${header}`);
  }

  if (operations.length === 0) throw new Error('Invalid patch: no file operations.');
  return { operations };
}

/** Best-effort path list for approval/scope previews: never throws, yields []. */
export function extractPatchPaths(patch: unknown): string[] {
  if (typeof patch !== 'string' || !patch.trimStart().startsWith(BEGIN_PATCH)) return [];
  try {
    return parseUpstreamApplyPatch(patch).operations.map((op) => op.path);
  } catch {
    return [];
  }
}

function normalizePatchLines(input: string): string[] {
  const normalized = input.replace(/\r\n?/g, '\n').trim();
  const lines = normalized.split('\n');

  // Upstream's lenient parser accepts the heredoc wrapper produced by a few
  // older models, but still validates the patch markers inside it.
  if (lines[0]?.startsWith('<<') && lines.length >= 3) {
    lines.shift();
    lines.pop();
  }
  return lines;
}

function isOperationHeader(line: string): boolean {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function readPath(line: string, prefix: string): string {
  const value = line.slice(prefix.length).trim();
  if (!value) throw new Error(`Invalid patch: empty path in '${prefix.trim()}'.`);
  return value;
}
