import path from 'path';
import { escapeRegExp, lineNumberAt } from './utils.js';
export const jsonProvider = {
    language: 'json',
    extensions: ['.json'],
    matches: (filePath) => path.extname(filePath) === '.json',
    declarationPatterns: (symbol) => [`"${escapeRegExp(symbol)}"\\s*:`],
    classifyMatch: () => ({ kind: 'unknown', exported: false }),
    extractOutline: (source) => {
        try {
            const parsed = JSON.parse(source);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { imports: [], exports: [], decls: [] };
            }
            // Use regex to find keys with accurate line numbers
            const decls = [];
            const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
            let keyMatch;
            const topLevelKeys = new Set(Object.keys(parsed));
            while ((keyMatch = keyRe.exec(source)) !== null) {
                const key = keyMatch[1];
                // Only include top-level keys to avoid duplicates and nested matches
                if (topLevelKeys.has(key)) {
                    decls.push({
                        name: key,
                        kind: 'unknown',
                        line: lineNumberAt(source, keyMatch.index),
                        exported: false,
                    });
                    topLevelKeys.delete(key);
                }
            }
            return { imports: [], exports: [], decls };
        }
        catch {
            return { imports: [], exports: [], decls: [] };
        }
    },
};
//# sourceMappingURL=json.js.map