const OPEN_FENCE_PATTERN = /^\s*(`{3,}|~{3,})([^\n]*)$/;
const CLOSE_FENCE_PATTERN = /^\s*([`~]{3,})\s*$/;
/** Extract fenced Markdown code blocks, excluding the fence and language hint. */
export function extractFencedCodeBlocks(text) {
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let openFence = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (!openFence) {
            const match = line.match(OPEN_FENCE_PATTERN);
            if (!match)
                continue;
            const marker = match[1];
            openFence = {
                character: marker[0],
                length: marker.length,
                contentStart: index + 1,
            };
            continue;
        }
        const closeMatch = line.match(CLOSE_FENCE_PATTERN);
        if (!closeMatch)
            continue;
        const marker = closeMatch[1];
        if (marker[0] !== openFence.character || marker.length < openFence.length)
            continue;
        blocks.push(lines.slice(openFence.contentStart, index).join('\n'));
        openFence = null;
    }
    return blocks;
}
export function buildCopySelections(response) {
    return [
        { label: 'Full response', text: response },
        ...extractFencedCodeBlocks(response).map((text, index) => ({
            label: `Code block #${index + 1}`,
            text,
        })),
    ];
}
//# sourceMappingURL=copy-selections.js.map