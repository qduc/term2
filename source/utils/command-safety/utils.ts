// Extract a best-effort string for a word/arg node, including expansions.
export function extractWordText(word: any): string | undefined {
    if (!word) return undefined;
    if (typeof word === 'string') return word;
    if (typeof word.text === 'string') return word.text;
    if (typeof word.value === 'string') return word.value;
    if (typeof word.content === 'string') return word.content;
    if (word.parameter) return `$${word.parameter}`;
    if (Array.isArray(word.parts)) {
        return word.parts
            .map((part: any) => extractWordText(part) ?? '')
            .join('');
    }
    return undefined;
}
