import path from 'path';
import { LanguageProvider, Outline, DeclarationKind, DeclEntry } from './types.js';
import { escapeRegExp, lineNumberAt } from './utils.js';

export const jsonProvider: LanguageProvider = {
  language: 'json',
  extensions: ['.json'],
  matches: (filePath) => path.extname(filePath) === '.json',
  declarationPatterns: (symbol) => [`"${escapeRegExp(symbol)}"\\s*:`],
  classifyMatch: () => ({ kind: 'unknown' as DeclarationKind, exported: false }),
  extractOutline: (source: string): Outline => {
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { imports: [], exports: [], decls: [] };
      }
      // Use regex to find keys with accurate line numbers
      const decls: DeclEntry[] = [];
      const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
      let keyMatch: RegExpExecArray | null;
      const topLevelKeys = new Set(Object.keys(parsed));
      while ((keyMatch = keyRe.exec(source)) !== null) {
        const key = keyMatch[1];
        // Only include top-level keys to avoid duplicates and nested matches
        if (topLevelKeys.has(key)) {
          decls.push({
            name: key,
            kind: 'unknown' as DeclarationKind,
            line: lineNumberAt(source, keyMatch.index),
            exported: false,
          });
          topLevelKeys.delete(key);
        }
      }
      return { imports: [], exports: [], decls };
    } catch {
      return { imports: [], exports: [], decls: [] };
    }
  },
};
