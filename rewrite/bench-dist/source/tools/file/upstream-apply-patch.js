/**
 * Parser for the upstream Codex freeform apply_patch grammar.
 *
 * The executor's argument is the raw patch string (`{ patch }`). This module
 * turns that string into operations for approval and execution. It is not a
 * tool-argument adapter: handing its `{ operations }` result to `apply_patch`
 * fails the `{ patch: string }` schema.
 */
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
/**
 * Tool arguments for a freeform apply_patch call. The grammar is checked
 * here, and the raw script is what execute and approval parse. The operations
 * object is not the tool argument.
 */
export function freeformApplyPatchArguments(input) {
    parseUpstreamApplyPatch(input);
    return { patch: input };
}
/** Parse the complete freeform payload into operations for approval and execution. */
export function parseUpstreamApplyPatch(input) {
    const lines = normalizePatchLines(input);
    if (lines[0] !== BEGIN_PATCH) {
        throw new Error(`Invalid patch: expected '${BEGIN_PATCH}' but found ${describeFoundLine(lines[0])}.`);
    }
    if (lines[lines.length - 1] !== END_PATCH) {
        const found = lines[lines.length - 1];
        const nearMatch = found.trimStart().startsWith('+*** End Patch');
        throw new Error(`Invalid patch: expected '${END_PATCH}' but found ${describeFoundLine(found)}.${nearMatch ? ` Remove the leading '+' so the line is exactly '${END_PATCH}'.` : ''}`);
    }
    let index = 1;
    if (lines[index]?.startsWith(ENVIRONMENT_ID)) {
        if (!lines[index].slice(ENVIRONMENT_ID.length).trim())
            throw new Error('Invalid patch: empty environment ID.');
        index += 1;
    }
    const operations = [];
    while (index < lines.length - 1) {
        const header = lines[index];
        if (header.startsWith(ADD_FILE)) {
            const filePath = readPath(header, ADD_FILE);
            index += 1;
            const body = [];
            while (index < lines.length - 1 && !isOperationHeader(lines[index]))
                body.push(lines[index++]);
            if (body.length === 0) {
                throw new Error(`Invalid Add File section for '${filePath}'.`);
            }
            // Body content is validated at execution (applyDiff/formatPatchError
            // produce actionable diagnostics); the parser only enforces structure
            // so malformed content flows to the same error path as Update sections.
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
            let moveTo;
            if (lines[index]?.startsWith(MOVE_TO)) {
                moveTo = readPath(lines[index], MOVE_TO);
                index += 1;
            }
            const body = [];
            while (index < lines.length - 1 && !isOperationHeader(lines[index]))
                body.push(lines[index++]);
            if (body.length === 0 && !moveTo)
                throw new Error(`Invalid Update File section for '${filePath}'.`);
            operations.push({ type: 'update_file', path: filePath, diff: body.join('\n'), ...(moveTo ? { moveTo } : {}) });
            continue;
        }
        throw new Error(`Invalid patch line: ${header}`);
    }
    if (operations.length === 0)
        throw new Error('Invalid patch: no file operations.');
    return { operations };
}
/** Best-effort path list for approval/scope previews: never throws, yields []. */
export function extractPatchPaths(patch) {
    if (typeof patch !== 'string' || !patch.trimStart().startsWith(BEGIN_PATCH))
        return [];
    try {
        return parseUpstreamApplyPatch(patch).operations.flatMap((op) => [
            op.path,
            ...('moveTo' in op && op.moveTo ? [op.moveTo] : []),
        ]);
    }
    catch {
        return [];
    }
}
function normalizePatchLines(input) {
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
function describeFoundLine(line) {
    if (line === undefined)
        return '<no line>';
    if (line === '')
        return '<empty line>';
    const maxLength = 120;
    const displayed = line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
    return JSON.stringify(displayed);
}
function isOperationHeader(line) {
    return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}
function readPath(line, prefix) {
    const value = line.slice(prefix.length).trim();
    if (!value)
        throw new Error(`Invalid patch: empty path in '${prefix.trim()}'.`);
    return value;
}
//# sourceMappingURL=upstream-apply-patch.js.map