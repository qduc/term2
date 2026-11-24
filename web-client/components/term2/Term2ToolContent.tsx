'use client';

import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { Check, Copy, ExternalLink, FileCode2, FileText, Folder, Search, Terminal } from 'lucide-react';
import type { Term2Command } from '../../lib/term2/types';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  sql: 'sql',
  dockerfile: 'dockerfile',
};

function languageForPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (base === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_LANG[base.slice(dot + 1)];
}

function highlightCode(code: string, language?: string): string | null {
  if (!code || code.length > 40_000) return null;
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function parseToolArgs(argumentsText?: string): Record<string, unknown> | null {
  if (!argumentsText) return null;
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function extractCleanToolError(raw?: string): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (Array.isArray(rec.output) && rec.output[0] && typeof rec.output[0] === 'object') {
        const first = rec.output[0] as Record<string, unknown>;
        if (typeof first.error === 'string') return first.error;
      }
      if (rec.error && typeof rec.error === 'object' && !Array.isArray(rec.error)) {
        const err = rec.error as Record<string, unknown>;
        if (typeof err.message === 'string') return err.message;
      }
      if (typeof rec.error === 'string') return rec.error;
      if (typeof rec.message === 'string') return rec.message;
    }
  } catch {
    /* plain text */
  }
  return raw;
}

interface ParsedReadFile {
  filePath: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  lines: string[];
}

export function parseReadFileOutput(output?: string): ParsedReadFile | null {
  if (!output) return null;
  const rawLines = output.split('\n');
  if (rawLines.length < 3 || !rawLines[0]?.startsWith('File: ') || rawLines[1] !== '===') return null;
  const match = rawLines[0].match(/^File:\s*(.*?)\s*\((\d+)\s*lines?\)\s*\[lines\s*(\d+)-(\d+)\]/);
  if (!match) return null;
  const body = rawLines.slice(2);
  // Drop a single trailing empty line produced by trailing newline
  if (body.length > 1 && body[body.length - 1] === '') body.pop();
  const lines = body.map((line) => line.replace(/^\s*\d+:\s?/, ''));
  return {
    filePath: match[1] ?? '',
    totalLines: Number.parseInt(match[2] ?? '0', 10),
    startLine: Number.parseInt(match[3] ?? '1', 10),
    endLine: Number.parseInt(match[4] ?? String(lines.length), 10),
    lines,
  };
}

interface ParsedGrep {
  files: Array<{ filePath: string; matches: Array<{ lineNum: number; content: string }> }>;
  totalMatches: number;
  note: string | null;
}

export function parseGrepOutput(output?: string): ParsedGrep | null {
  if (!output) return null;
  const rawLines = output.split('\n').filter((line) => !line.trimStart().startsWith('rg:'));
  const byFile = new Map<string, Array<{ lineNum: number; content: string }>>();
  let note: string | null = null;
  let totalMatches = 0;

  for (const line of rawLines) {
    if (!line.trim()) continue;
    if (line.startsWith('Note:')) {
      note = line;
      continue;
    }
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) return null;
    const filePath = match[1] ?? '';
    const lineNum = Number.parseInt(match[2] ?? '0', 10);
    const content = match[3] ?? '';
    const list = byFile.get(filePath) ?? [];
    list.push({ lineNum, content });
    byFile.set(filePath, list);
    totalMatches += 1;
  }
  if (totalMatches === 0) return null;
  return {
    files: [...byFile.entries()].map(([filePath, matches]) => ({ filePath, matches })),
    totalMatches,
    note,
  };
}

interface ParsedFileList {
  files: string[];
  note: string | null;
}

export function parseFileListOutput(output?: string): ParsedFileList | null {
  if (!output) return null;
  const files: string[] = [];
  let note: string | null = null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('Note:')) {
      note = trimmed;
      continue;
    }
    if (trimmed.startsWith('Error:') || trimmed.startsWith('No files found')) return null;
    files.push(trimmed);
  }
  return files.length > 0 ? { files, note } : null;
}

export function computeDiffLines(
  toolName: string,
  args: Record<string, unknown> | null,
): Array<{ kind: '+' | '-' | 'hunk' | ' '; text: string }> | null {
  if (!args) return null;
  const rawPatch =
    toolName === 'apply_patch'
      ? typeof args.patch === 'string'
        ? args.patch
        : typeof args.diff === 'string'
          ? args.diff
          : null
      : null;
  if (rawPatch) {
    return rawPatch.split('\n').map((line) => {
      if (line.startsWith('@@') || line.startsWith('*** ')) return { kind: 'hunk', text: line };
      if (line.startsWith('+') && !line.startsWith('+++')) return { kind: '+', text: line.slice(1) };
      if (line.startsWith('-') && !line.startsWith('---')) return { kind: '-', text: line.slice(1) };
      return { kind: ' ', text: line };
    });
  }
  if (toolName === 'search_replace') {
    if (Array.isArray(args.replacements)) {
      const out: Array<{ kind: '+' | '-' | 'hunk' | ' '; text: string }> = [];
      args.replacements.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') return;
        const rep = entry as Record<string, unknown>;
        if (idx > 0) out.push({ kind: 'hunk', text: `Replacement ${idx + 1}` });
        if (typeof rep.search_content === 'string') {
          out.push(...rep.search_content.split('\n').map((text) => ({ kind: '-' as const, text })));
        }
        if (typeof rep.replace_content === 'string') {
          out.push(...rep.replace_content.split('\n').map((text) => ({ kind: '+' as const, text })));
        }
      });
      return out.length > 0 ? out : null;
    }
    if (typeof args.search_content === 'string' && typeof args.replace_content === 'string') {
      return [
        ...args.search_content.split('\n').map((text) => ({ kind: '-' as const, text })),
        ...args.replace_content.split('\n').map((text) => ({ kind: '+' as const, text })),
      ];
    }
  }
  if (toolName === 'create_file' && typeof args.content === 'string') {
    return args.content
      .split('\n')
      .slice(0, 200)
      .map((text) => ({ kind: '+' as const, text }));
  }
  return null;
}

export function summarizeCommandMeta(command: Term2Command): string | null {
  const args = parseToolArgs(command.argumentsText);
  if (command.toolName === 'read_file' || command.toolName === 'view_file') {
    const parsed = parseReadFileOutput(command.output);
    if (parsed) return `${parsed.lines.length} ${parsed.lines.length === 1 ? 'line' : 'lines'}`;
  }
  if (command.toolName === 'grep') {
    const parsed = parseGrepOutput(command.output);
    if (parsed) return `${parsed.totalMatches} ${parsed.totalMatches === 1 ? 'match' : 'matches'}`;
  }
  if (command.toolName === 'glob' || command.toolName === 'find_files') {
    const parsed = parseFileListOutput(command.output);
    if (parsed) return `${parsed.files.length} ${parsed.files.length === 1 ? 'file' : 'files'}`;
  }
  if (command.toolName === 'shell' && command.output) {
    const m = command.output.match(/(?:^|\r?\n)Runtime:\s*(\d+ms)(?:\r?\n|$)/);
    if (m) return m[1];
  }
  const diffLines = computeDiffLines(command.toolName, args);
  if (diffLines) {
    const added = diffLines.filter((l) => l.kind === '+').length;
    const removed = diffLines.filter((l) => l.kind === '-').length;
    if (added > 0 || removed > 0) {
      return [added > 0 ? `+${added}` : '', removed > 0 ? `-${removed}` : ''].filter(Boolean).join(' ');
    }
  }
  return null;
}

function SmallCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => undefined);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 dark:hover:bg-white/10"
    >
      {copied ? <Check className="h-3 w-3 text-teal-400" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function DiffBlock({ lines }: { lines: Array<{ kind: '+' | '-' | 'hunk' | ' '; text: string }> }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-xl border border-black/[0.07] bg-white py-1.5 font-mono text-[12px] leading-5 dark:border-white/[0.08] dark:bg-zinc-950/70">
      {lines.map((line, index) => (
        <div
          key={index}
          className={`flex ${
            line.kind === '+'
              ? 'bg-emerald-500/[0.09] text-emerald-800 dark:bg-emerald-400/[0.1] dark:text-emerald-300'
              : line.kind === '-'
                ? 'bg-red-500/[0.08] text-red-800 dark:bg-red-400/[0.1] dark:text-red-300'
                : line.kind === 'hunk'
                  ? 'bg-zinc-100/80 text-zinc-500 dark:bg-white/[0.04] dark:text-zinc-400'
                  : 'text-zinc-600 dark:text-zinc-400'
          }`}
        >
          <span aria-hidden className="w-7 shrink-0 select-none text-center opacity-60">
            {line.kind === ' ' || line.kind === 'hunk' ? '' : line.kind}
          </span>
          <span className="whitespace-pre pr-3">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

function ParamChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-black/[0.07] bg-white px-2 py-0.5 text-[11.5px] dark:border-white/[0.08] dark:bg-zinc-900">
      <span className="text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-700 dark:text-zinc-200">{value}</span>
    </span>
  );
}

function formatKeyLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Clean, human-readable Web UI view of tool input arguments.
 * Used both inside expanded tool cards and in tool approval prompts.
 */
export function ToolInputPreview({
  toolName,
  argumentsText,
  compact = false,
}: {
  toolName: string;
  argumentsText?: string;
  compact?: boolean;
}) {
  const args = useMemo(() => parseToolArgs(argumentsText), [argumentsText]);
  const diffLines = useMemo(() => computeDiffLines(toolName, args), [toolName, args]);

  if (!argumentsText) return null;

  if (!args) {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2 font-mono text-[12px] leading-5 text-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">
        {argumentsText}
      </pre>
    );
  }

  // Shell command preview
  if (toolName === 'shell' && typeof args.command === 'string') {
    const metaChips: Array<{ label: string; value: string }> = [];
    if (typeof args.cwd === 'string' && args.cwd) metaChips.push({ label: 'cwd', value: args.cwd });
    if (typeof args.sandbox === 'string' && args.sandbox !== 'default') {
      metaChips.push({ label: 'sandbox', value: args.sandbox });
    }
    if (args.background === true) metaChips.push({ label: 'mode', value: 'background' });
    if (typeof args.timeout === 'number') metaChips.push({ label: 'timeout', value: `${args.timeout}ms` });
    return (
      <div className="space-y-1.5">
        <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950 text-zinc-100">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-1.5 text-[11px] text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <Terminal className="h-3 w-3 text-teal-400" />
              Shell command
            </span>
            <SmallCopyButton text={args.command} />
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-[12.5px] leading-5">
            <span className="select-none text-teal-400">$ </span>
            {args.command}
          </pre>
        </div>
        {metaChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {metaChips.map((chip) => (
              <ParamChip key={chip.label} label={chip.label} value={chip.value} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File read preview
  if ((toolName === 'read_file' || toolName === 'view_file') && (typeof args.path === 'string' || typeof args.file_path === 'string')) {
    const filePath = String(args.path ?? args.file_path);
    const start = typeof args.start_line === 'number' ? args.start_line : typeof args.offset === 'number' ? args.offset : null;
    const end = typeof args.end_line === 'number' ? args.end_line : typeof args.limit === 'number' && start !== null ? start + args.limit - 1 : null;
    if (compact && start === null && end === null) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white px-2.5 py-1 font-mono text-xs text-zinc-800 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-200">
          <FileCode2 className="h-3.5 w-3.5 text-zinc-400" />
          {filePath}
        </span>
        {start !== null && (
          <ParamChip label="lines" value={end !== null ? `${start}–${end}` : `from ${start}`} />
        )}
      </div>
    );
  }

  // Edit / create diff preview
  if (diffLines) {
    const filePath = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
    return (
      <div className="space-y-1.5">
        {filePath && !compact && (
          <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            <FileCode2 className="h-3.5 w-3.5 text-zinc-400" />
            <span className="font-mono">{filePath}</span>
          </div>
        )}
        <DiffBlock lines={diffLines} />
      </div>
    );
  }

  // Grep / search preview
  if ((toolName === 'grep' || toolName === 'glob' || toolName === 'find_files' || toolName === 'code_context_search') && typeof args.pattern === 'string') {
    const chips: Array<{ label: string; value: string }> = [];
    if (typeof args.path === 'string' && args.path) chips.push({ label: 'in', value: args.path });
    if (typeof args.glob === 'string' && args.glob) chips.push({ label: 'files', value: args.glob });
    if (typeof args.file_type === 'string' && args.file_type) chips.push({ label: 'type', value: args.file_type });
    if (args.case_insensitive === true) chips.push({ label: 'case', value: 'insensitive' });
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.07] bg-white px-2.5 py-1 font-mono text-xs text-zinc-800 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-200">
          <Search className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
          {args.pattern}
        </span>
        {chips.map((c) => (
          <ParamChip key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
    );
  }

  // Web search / fetch
  if (toolName === 'web_fetch' && typeof args.url === 'string') {
    const safeHttpUrl = /^https?:\/\//i.test(args.url.trim()) ? args.url.trim() : null;
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {safeHttpUrl ? (
          <a
            href={safeHttpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-black/[0.07] bg-white px-2.5 py-1 font-mono text-teal-700 hover:underline dark:border-white/[0.08] dark:bg-zinc-900 dark:text-teal-400"
          >
            <span className="max-w-md truncate">{safeHttpUrl}</span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        ) : (
          <span className="inline-flex max-w-md truncate rounded-lg border border-black/[0.07] bg-white px-2.5 py-1 font-mono text-zinc-700 dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-300">
            {args.url}
          </span>
        )}
      </div>
    );
  }

  // Generic structured key-value view (no raw 1-line JSON blobs!)
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return null;

  return (
    <dl className="grid grid-cols-1 gap-2 rounded-xl border border-black/[0.06] bg-white/80 p-3 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-4 dark:border-white/[0.07] dark:bg-zinc-950/40">
      {entries.map(([key, value]) => {
        const isMultiline = typeof value === 'string' && (value.includes('\n') || value.length > 100);
        const isComplex = typeof value === 'object';
        return (
          <div key={key} className="contents">
            <dt className="font-medium text-zinc-500 dark:text-zinc-400">{formatKeyLabel(key)}</dt>
            <dd className="min-w-0 text-zinc-800 dark:text-zinc-200">
              {isComplex ? (
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100/80 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 dark:bg-white/[0.05]">
                  {JSON.stringify(value, null, 2)}
                </pre>
              ) : isMultiline ? (
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-100/80 px-2.5 py-1.5 font-mono text-[11.5px] leading-5 dark:bg-white/[0.05]">
                  {String(value)}
                </pre>
              ) : (
                <span className="break-words font-mono text-[12px]">{String(value)}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const OUTPUT_PREVIEW_CHARS = 5000;

/**
 * Formatted tool output viewer for the Web UI:
 * - read_file: syntax-highlighted code with line numbers
 * - grep: grouped per-file match cards
 * - glob / find_files: clean file list
 * - shell: terminal output block with runtime chip
 * - JSON: pretty-printed syntax-highlighted JSON
 * - plain text: readable preformatted block with copy & show-all controls
 */
export function ToolOutputPreview({ toolName, output }: { toolName: string; output: string }) {
  const [showAll, setShowAll] = useState(false);

  // All hooks must run unconditionally on every render (Rules of Hooks).
  const readFile = useMemo(
    () => (toolName === 'read_file' || toolName === 'view_file' ? parseReadFileOutput(output) : null),
    [toolName, output],
  );
  const readFileCode = useMemo(() => (readFile ? readFile.lines.join('\n') : ''), [readFile]);
  const readFileLang = useMemo(() => (readFile ? languageForPath(readFile.filePath) : undefined), [readFile]);
  const readFileHtmlLines = useMemo(() => {
    if (!readFile) return null;
    const html = highlightCode(readFileCode, readFileLang);
    return html ? html.split('\n') : null;
  }, [readFile, readFileCode, readFileLang]);

  const grep = useMemo(() => (toolName === 'grep' ? parseGrepOutput(output) : null), [toolName, output]);
  const fileList = useMemo(
    () => (toolName === 'glob' || toolName === 'find_files' ? parseFileListOutput(output) : null),
    [toolName, output],
  );
  const prettyJson = useMemo(() => {
    if (readFile || grep || fileList || toolName === 'shell') return null;
    const trimmed = output.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const pretty = JSON.stringify(parsed, null, 2);
        return { pretty, html: highlightCode(pretty, 'json') };
      }
    } catch {
      /* plain text */
    }
    return null;
  }, [output, readFile, grep, fileList, toolName]);

  // 1. read_file / view_file structured code block
  if (readFile) {
    const maxRows = showAll ? readFile.lines.length : 60;
    const visible = readFile.lines.slice(0, maxRows);
    const hiddenCount = readFile.lines.length - visible.length;
    return (
      <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-zinc-950/60">
        <div className="flex items-center justify-between gap-2 border-b border-black/[0.06] bg-zinc-50/90 px-3 py-1.5 text-[11.5px] text-zinc-500 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-zinc-400">
          <span className="flex min-w-0 items-center gap-1.5 font-mono">
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <span className="truncate text-zinc-700 dark:text-zinc-200">{readFile.filePath}</span>
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className="tabular-nums text-[11px] text-zinc-400">
              lines {readFile.startLine}–{readFile.endLine} of {readFile.totalLines}
            </span>
            <SmallCopyButton text={readFileCode} />
          </div>
        </div>
        <div className="max-h-80 overflow-auto py-1.5 font-mono text-[12px] leading-5">
          {visible.map((line, idx) => (
            <div key={idx} className="flex px-2 hover:bg-black/[0.025] dark:hover:bg-white/[0.03]">
              <span className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-zinc-400 dark:text-zinc-600">
                {readFile.startLine + idx}
              </span>
              {readFileHtmlLines && readFileHtmlLines[idx] !== undefined ? (
                <span
                  className="hljs min-w-0 flex-1 whitespace-pre"
                  dangerouslySetInnerHTML={{ __html: readFileHtmlLines[idx] || '&nbsp;' }}
                />
              ) : (
                <span className="min-w-0 flex-1 whitespace-pre text-zinc-800 dark:text-zinc-200">{line || ' '}</span>
              )}
            </div>
          ))}
        </div>
        {hiddenCount > 0 && (
          <div className="border-t border-black/[0.06] px-3 py-1.5 dark:border-white/[0.07]">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              Show {hiddenCount} more lines
            </button>
          </div>
        )}
      </div>
    );
  }

  // 2. grep structured matches by file
  if (grep) {
    const visibleFiles = showAll ? grep.files : grep.files.slice(0, 10);
    return (
      <div className="space-y-2">
        <div className="max-h-80 space-y-2 overflow-y-auto scrollbar-thin">
          {visibleFiles.map((file) => (
            <div
              key={file.filePath}
              className="overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-zinc-950/60"
            >
              <div className="flex items-center justify-between gap-2 border-b border-black/[0.05] bg-zinc-50/80 px-3 py-1 text-[11.5px] dark:border-white/[0.06] dark:bg-white/[0.03]">
                <span className="truncate font-mono font-medium text-zinc-800 dark:text-zinc-200">{file.filePath}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                  {file.matches.length} {file.matches.length === 1 ? 'match' : 'matches'}
                </span>
              </div>
              <div className="py-1 font-mono text-[12px] leading-5">
                {file.matches.slice(0, showAll ? undefined : 15).map((m, i) => (
                  <div key={i} className="flex px-2 hover:bg-black/[0.025] dark:hover:bg-white/[0.03]">
                    <span className="w-10 shrink-0 select-none pr-3 text-right tabular-nums text-zinc-400 dark:text-zinc-600">
                      {m.lineNum}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">
                      {m.content}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {!showAll && grep.files.length > visibleFiles.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
          >
            Show {grep.files.length - visibleFiles.length} more files
          </button>
        )}
        {grep.note && <p className="text-xs text-amber-700 dark:text-amber-400">{grep.note}</p>}
      </div>
    );
  }

  // 3. glob / find_files structured file list
  if (fileList) {
    const visible = showAll ? fileList.files : fileList.files.slice(0, 40);
    return (
      <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-zinc-950/60">
        <div className="flex items-center justify-between border-b border-black/[0.05] bg-zinc-50/80 px-3 py-1.5 text-[11.5px] text-zinc-500 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-zinc-400">
          <span>
            {fileList.files.length} {fileList.files.length === 1 ? 'file' : 'files'}
          </span>
          <SmallCopyButton text={fileList.files.join('\n')} />
        </div>
        <ul className="max-h-64 divide-y divide-black/[0.04] overflow-y-auto font-mono text-[12px] dark:divide-white/[0.04]">
          {visible.map((file) => (
            <li key={file} className="flex items-center gap-2 px-3 py-1 text-zinc-700 dark:text-zinc-300">
              {file.endsWith('/') ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              )}
              <span className="truncate">{file}</span>
            </li>
          ))}
        </ul>
        {!showAll && fileList.files.length > visible.length && (
          <div className="border-t border-black/[0.06] px-3 py-1.5 dark:border-white/[0.07]">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              Show all {fileList.files.length} files
            </button>
          </div>
        )}
        {fileList.note && <p className="border-t border-black/[0.05] px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">{fileList.note}</p>}
      </div>
    );
  }

  // 4. Shell output (extract Runtime chip + terminal style)
  if (toolName === 'shell') {
    const runtimeMatch = output.match(/(?:^|\r?\n)Runtime:\s*(\d+ms)(?:\r?\n|$)/);
    const cleaned = runtimeMatch
      ? output.replace(/(?:^|\r?\n)Runtime:\s*\d+ms(?:\r?\n|$)/, '\n').trim()
      : output.trimEnd();
    const clipped = !showAll && cleaned.length > OUTPUT_PREVIEW_CHARS;
    return (
      <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-zinc-900/95 text-zinc-100 dark:border-white/[0.08]">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-1 text-[11px] text-zinc-400">
          <span>Output{runtimeMatch ? ` · ${runtimeMatch[1]}` : ''}</span>
          <SmallCopyButton text={cleaned} />
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-[12px] leading-5">
          {cleaned ? (clipped ? cleaned.slice(0, OUTPUT_PREVIEW_CHARS) : cleaned) : '(no output)'}
        </pre>
        {clipped && (
          <div className="border-t border-white/[0.07] px-3 py-1.5">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs font-medium text-teal-400 hover:underline"
            >
              Show all {cleaned.length.toLocaleString()} characters
            </button>
          </div>
        )}
      </div>
    );
  }

  // 5. Structured JSON output -> pretty print with syntax highlighting
  if (prettyJson) {
    const clipped = !showAll && prettyJson.pretty.length > OUTPUT_PREVIEW_CHARS;
    return (
      <div className="overflow-hidden rounded-xl border border-black/[0.06] bg-zinc-50 dark:border-white/[0.07] dark:bg-zinc-950/60">
        <div className="flex items-center justify-between border-b border-black/[0.05] px-3 py-1 text-[11px] text-zinc-500 dark:border-white/[0.06]">
          <span>Result (JSON)</span>
          <SmallCopyButton text={prettyJson.pretty} />
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-5">
          {!clipped && prettyJson.html ? (
            <code className="hljs" dangerouslySetInnerHTML={{ __html: prettyJson.html }} />
          ) : (
            <code className="text-zinc-700 dark:text-zinc-300">
              {clipped ? prettyJson.pretty.slice(0, OUTPUT_PREVIEW_CHARS) : prettyJson.pretty}
            </code>
          )}
        </pre>
        {clipped && (
          <div className="border-t border-black/[0.05] px-3 py-1.5 dark:border-white/[0.06]">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
            >
              Show all {prettyJson.pretty.length.toLocaleString()} characters
            </button>
          </div>
        )}
      </div>
    );
  }

  // 6. Plain text output
  const clipped = !showAll && output.length > OUTPUT_PREVIEW_CHARS;
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">
        {clipped ? output.slice(0, OUTPUT_PREVIEW_CHARS) : output}
      </pre>
      {clipped && (
        <button
          type="button"
          className="mt-1.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
          onClick={() => setShowAll(true)}
        >
          Show all {output.length.toLocaleString()} characters
        </button>
      )}
    </div>
  );
}
