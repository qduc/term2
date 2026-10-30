import fs from 'node:fs/promises';
import path from 'node:path';
function noteName(raw) {
    const name = raw?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
        throw new Error('name must be 1-64 letters, digits, _ or -');
    return name;
}
const notePath = (ctx, name) => path.join(ctx.workspace.root, `${name}.txt`);
/** Read-only, so it runs without approval. */
export const readNote = {
    spec: {
        name: 'read_note',
        description: 'Read a note from the workspace.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    parse: (raw) => ({ name: noteName(raw) }),
    approval: () => ({ kind: 'none' }),
    async execute(input, ctx) {
        try {
            return { output: await fs.readFile(notePath(ctx, input.name), 'utf8'), isError: false };
        }
        catch {
            return { output: `note "${input.name}" not found`, isError: true };
        }
    },
};
/** Writes a file, so it asks first. */
export const writeNote = {
    spec: {
        name: 'write_note',
        description: 'Write a note to the workspace.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' }, text: { type: 'string' } },
            required: ['name', 'text'],
        },
    },
    parse(raw) {
        const text = raw?.text;
        if (typeof text !== 'string')
            throw new Error('text must be a string');
        return { name: noteName(raw), text };
    },
    approval: (input, ctx) => ctx.workspace.access === 'read'
        ? { kind: 'deny', reason: 'workspace is read-only' }
        : { kind: 'ask', summary: `Write note "${input.name}"`, risk: 'medium', detail: input.text },
    async execute(input, ctx) {
        await fs.writeFile(notePath(ctx, input.name), input.text, 'utf8');
        return { output: `wrote ${input.text.length} characters to "${input.name}"`, isError: false };
    },
};
export function toolRegistry(tools) {
    const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
    return {
        get: (name) => byName.get(name),
        available: () => [...byName.values()],
    };
}
//# sourceMappingURL=notes.js.map