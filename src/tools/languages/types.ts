export type DeclarationKind =
  | 'function'
  | 'async function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'let'
  | 'var'
  | 'method'
  | 'unknown';

export interface ImportEntry {
  specifier: string;
  names: string[];
  line: number;
}

export interface DeclEntry {
  name: string;
  kind: DeclarationKind;
  line: number;
  exported: boolean;
}

export interface ExportEntry {
  name: string;
  kind?: DeclarationKind;
  source?: string;
  line: number;
}

export interface Outline {
  imports: ImportEntry[];
  exports: ExportEntry[];
  decls: DeclEntry[];
}

export interface LanguageProvider {
  language: string;
  extensions: string[];
  matches: (filePath: string) => boolean;
  declarationPatterns: (symbol: string) => string[];
  classifyMatch: (line: string, symbol: string) => { kind: DeclarationKind; exported: boolean };
  extractOutline?: (source: string) => Outline;
  resolveImport?: (specifier: string, fromPath: string, root: string) => Promise<string | null>;
  testPatterns?: (filePath: string) => { forSource: string[] };
}
