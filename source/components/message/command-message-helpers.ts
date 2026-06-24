import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

const TOOL_NAME_GREP = 'grep' as const;
const TOOL_NAME_GLOB = 'glob' as const;

export type SearchKind = 'grep' | 'glob' | 'shell';

const SEARCH_TOOL_NAMES = new Set<string>([TOOL_NAME_GREP, TOOL_NAME_GLOB]);

const SEARCH_COMMANDS = ['grep', 'rg', 'find', 'fd', 'ag', 'ack', 'git grep'];

export const stripRgErrorLines = (output: string | undefined): string => {
  if (!output) return '';

  return output
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('rg:'))
    .join('\n');
};

export const getFirstParagraph = (text: string | undefined, minChars = 0): string => {
  if (!text) return '';
  const trimmed = text.trim();
  if (minChars <= 0) {
    const paragraphs = trimmed.split(/\n\s*\n/);
    return paragraphs[0]?.trim() || '';
  }

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return '';

  let result = paragraphs[0] || '';
  let i = 1;
  while (result.length < minChars && i < paragraphs.length) {
    // separate paragraphs with a blank line to preserve paragraph boundaries
    result = `${result}\n\n${paragraphs[i]}`;
    i += 1;
  }

  // If still shorter than minChars, fall back to returning the whole trimmed text
  if (result.length < minChars) return trimmed;

  return result.trim();
};

export const isSearchLikeTool = (toolName: string | undefined, command: string): boolean => {
  if (toolName && SEARCH_TOOL_NAMES.has(toolName)) return true;
  if (toolName === 'shell' || !toolName) {
    const cmd = command.trim().split(/\s+/)[0] ?? '';
    if (cmd && SEARCH_COMMANDS.some((sc) => cmd === sc || cmd.endsWith(`/${sc}`))) return true;
  }
  return false;
};

export const parseGrepOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = stripRgErrorLines(output).split('\n');
  const matchesByFile: Record<string, { lineNum: number; content: string }[]> = {};
  let note: string | null = null;
  let isAllMatches = true;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('Note:')) {
      note = line;
      continue;
    }
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (match) {
      const filePath = match[1] ?? '';
      const lineNum = parseInt(match[2] ?? '0', 10);
      const content = match[3] ?? '';
      if (!matchesByFile[filePath]) {
        matchesByFile[filePath] = [];
      }
      matchesByFile[filePath].push({ lineNum, content });
    } else {
      isAllMatches = false;
      break;
    }
  }

  if (isAllMatches && Object.keys(matchesByFile).length > 0) {
    return { matchesByFile, note };
  }
  return null;
};

export const parseFindFilesOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  const files: string[] = [];
  let note: string | null = null;
  let isAllFiles = true;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('Note:')) {
      note = line;
      continue;
    }
    if (line.startsWith('Error:') || line.startsWith('No files found')) {
      isAllFiles = false;
      break;
    }
    files.push(line);
  }

  if (isAllFiles && files.length > 0) {
    return { files, note };
  }
  return null;
};

export const classifySearchKind = (toolName: string | undefined, command: string): SearchKind => {
  if (toolName === TOOL_NAME_GREP) return 'grep';
  if (toolName === TOOL_NAME_GLOB) return 'glob';

  void command;
  return 'shell';
};

export const getMatchCount = (toolName: string | undefined, command: string, output: string | undefined): number => {
  if (!output) return 0;

  const sanitizedOutput = stripRgErrorLines(output);
  if (!sanitizedOutput.trim()) return 0;

  const searchKind = classifySearchKind(toolName, command);
  if (searchKind === 'grep') {
    const parsed = parseGrepOutput(sanitizedOutput);
    if (parsed) {
      return Object.values(parsed.matchesByFile).reduce((acc, matches) => acc + matches.length, 0);
    }
    // Structured parser returned null — the output isn't a parseable match list.
    // Don't fall through to the shell counter; return 0 to avoid miscounting error
    // messages or no-result strings as matches.
    return 0;
  } else if (searchKind === 'glob') {
    const parsed = parseFindFilesOutput(sanitizedOutput);
    if (parsed) {
      return parsed.files.length;
    }
    // Same reasoning as above: unparseable output should yield 0.
    return 0;
  }

  // Shell fallback: count visible result lines when the tool is a shell-routed search
  // or the structured parsers cannot decode the output. These skip rules mirror the
  // dedicated parsers above, but they still intentionally overcount unfamiliar summaries.
  let count = 0;
  for (let line of sanitizedOutput.split('\n')) {
    line = line.trim();
    if (!line) continue;
    const lowerLine = line.toLowerCase();
    if (
      line.startsWith('Note:') ||
      line.startsWith('Error:') ||
      line.startsWith('grep: ') ||
      line.startsWith('rg: ') ||
      line.startsWith('find: ') ||
      line === '--' ||
      lowerLine.startsWith('no matches found') ||
      lowerLine.startsWith('no files found') ||
      lowerLine === 'no matches'
    ) {
      continue;
    }
    count++;
  }
  return count;
};

export type DiffStats = {
  added: number;
  removed: number;
};

export const parseReadFileOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 3 && lines[0]?.startsWith('File: ') && lines[1] === '===') {
    const header = lines[0] ?? '';
    const match = header.match(/File:\s*(.*?)\s*\((\d+)\s*lines\)\s*\[lines\s*(\d+)-(\d+)\]/);
    // Strip line-number prefixes (e.g. "1: ") added by the read_file tool
    const contentLines = lines.slice(2).map((line) => line.replace(/^\d+:\s?/, ''));
    if (match) {
      return {
        filePath: match[1],
        totalLines: parseInt(match[2] ?? '0', 10),
        startLine: parseInt(match[3] ?? '1', 10),
        endLine: parseInt(match[4] ?? '1', 10),
        contentLines,
      };
    }
  }
  return null;
};

export const parseSubagentOutput = (output: string | undefined, toolArgs: any) => {
  if (!output) return null;

  let status = 'completed';
  let toolsUsed = '';
  let filesChanged = '';
  let mainText = output;

  const lines = output.split('\n');
  const remainingLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('Status: ')) {
      status = line.replace('Status: ', '').trim();
    } else if (line.startsWith('Tools: ') || line.startsWith('Tools used: ')) {
      toolsUsed = line.replace(/Tools( used)?: /, '').trim();
    } else if (line.startsWith('Files changed: ')) {
      filesChanged = line.replace('Files changed: ', '').trim();
    } else if (line.startsWith('Error: ')) {
      status = 'failed';
      remainingLines.push(line);
    } else {
      remainingLines.push(line);
    }
  }

  mainText = remainingLines.join('\n').trim();

  return {
    role: toolArgs?.role ?? 'subagent',
    status,
    toolsUsed,
    filesChanged,
    mainText,
  };
};

export const parseWebSearchOutput = (output: string | undefined) => {
  if (!output) return null;

  const normalized = output.replace(/^##\s+/gm, '## ').trim();
  if (!normalized.includes('## Answer') && !normalized.includes('## Search Results')) {
    return null;
  }

  let answer: string | null = null;
  const results: { title: string; url: string; published?: string; content: string }[] = [];

  const sections = normalized.split(/(?:^|\n)##\s+/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('Answer')) {
      answer = trimmed.replace(/^Answer\r?\n/, '').trim();
    } else if (trimmed.startsWith('Search Results')) {
      const resultItems = trimmed.split(/(?:^|\n)###\s+/);
      for (const item of resultItems) {
        const itemTrimmed = item.trim();
        if (!itemTrimmed || itemTrimmed.startsWith('Search Results')) continue;

        const lines = itemTrimmed.split('\n');
        const titleLine = lines[0] ?? '';
        const title = titleLine.replace(/^\d+\.\s*/, '').trim();

        let url = '';
        let published = '';
        const contentLines: string[] = [];

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]?.trim();
          if (!line) continue;
          if (line.startsWith('**URL:**')) {
            url = line.replace('**URL:**', '').trim();
          } else if (line.startsWith('**Published:**')) {
            published = line.replace('**Published:**', '').trim();
          } else if (line === '---') {
            // End of item
          } else {
            contentLines.push(lines[i] ?? '');
          }
        }

        if (title && url) {
          results.push({
            title,
            url,
            published: published || undefined,
            content: contentLines.join('\n').trim(),
          });
        }
      }
    }
  }

  return { answer, results };
};

export const parseWebFetchOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('Title: ') && lines[1]?.startsWith('URL: ')) {
    const title = lines[0].replace('Title: ', '').trim();
    const url = lines[1].replace('URL: ', '').trim();

    let toc: string | null = null;
    let tempFile: string | null = null;
    let notes: string | null = null;
    const contentLines: string[] = [];

    let inToc = false;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmedLine = line.trim();

      if (trimmedLine === '## Table of Contents') {
        inToc = true;
        toc = '';
        continue;
      }

      if (inToc && trimmedLine === '---') {
        inToc = false;
        continue;
      }

      if (inToc) {
        toc += line + '\n';
        continue;
      }

      if (trimmedLine.startsWith('**Note: Content still truncated.')) {
        notes = (notes ? notes + '\n' : '') + trimmedLine;
        continue;
      }

      if (trimmedLine.startsWith('**Full content saved to temp file:')) {
        const match = trimmedLine.match(/temp file:\s*`(.*?)`/);
        if (match) {
          tempFile = match[1] ?? '';
        }
        continue;
      }

      if (trimmedLine.startsWith('The full content has been saved for reference.')) {
        continue;
      }

      contentLines.push(line);
    }

    return {
      title,
      url,
      toc: toc?.trim() || null,
      tempFile,
      notes,
      content: contentLines.join('\n').trim(),
    };
  }
  return null;
};

export const parseCodeOutlineOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('FILE ') && lines[1]?.startsWith('LANG ')) {
    const filePath = lines[0].replace('FILE ', '').trim();
    const lang = lines[1].replace('LANG ', '').trim();

    const imports: string[] = [];
    const exports: string[] = [];
    const decls: string[] = [];

    let section: 'imports' | 'exports' | 'decls' | null = null;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (line === 'IMPORTS') {
        section = 'imports';
        continue;
      }
      if (line === 'EXPORTS') {
        section = 'exports';
        continue;
      }
      if (line === 'DECLARATIONS') {
        section = 'decls';
        continue;
      }
      if (line === 'EMPTY') {
        continue;
      }

      if (section === 'imports') {
        imports.push(line);
      } else if (section === 'exports') {
        exports.push(line);
      } else if (section === 'decls') {
        decls.push(line);
      }
    }

    return { filePath, lang, imports, exports, decls };
  }
  return null;
};

export const parseCodeContextSearchOutput = (output: string | undefined) => {
  if (!output) return null;
  const lines = output.split('\n');
  if (lines.length >= 2 && lines[0]?.startsWith('QUERY ')) {
    const queryType = lines[0].replace('QUERY ', '').trim();

    if (queryType === 'related') {
      const target = lines[1]?.startsWith('TARGET ') ? lines[1].replace('TARGET ', '').trim() : '';
      const relatedFiles: { filePath: string; relations: string }[] = [];

      let currentFile = '';
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line || line === 'NO_RESULTS') continue;
        if (line.startsWith('REL ')) {
          if (currentFile) {
            relatedFiles.push({
              filePath: currentFile,
              relations: line.replace('REL ', '').trim(),
            });
            currentFile = '';
          }
        } else if (!line.startsWith('WARNING ')) {
          currentFile = line;
        }
      }

      return { queryType, target, relatedFiles };
    } else if (queryType === 'symbol') {
      const symbol = lines[1]?.startsWith('SYMBOL ') ? lines[1].replace('SYMBOL ', '').trim() : '';
      const results: { filePath: string; lineNum: number; kind: string; name: string; exported: boolean }[] = [];

      for (let i = 2; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line || line === 'NO_RESULTS' || line.startsWith('WARNING ')) continue;

        const match = line.match(/^(.*?):(\d+)\s+(\w+)\s+(\S+)(?:\s+(exported))?$/);
        if (match) {
          results.push({
            filePath: match[1] ?? '',
            lineNum: parseInt(match[2] ?? '0', 10),
            kind: match[3] ?? '',
            name: match[4] ?? '',
            exported: !!match[5],
          });
        }
      }

      return { queryType, symbol, results };
    }
  }
  return null;
};

export const formatToolArgs = (
  toolName: string | undefined,
  args: any,
  displayMode?: 'standard' | 'concise',
): string => {
  if (!args || !toolName) {
    return '';
  }

  const normalizedArgs: any = (() => {
    if (typeof args !== 'string') {
      return args;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  })();

  if (!normalizedArgs || typeof normalizedArgs !== 'object') {
    return '';
  }

  try {
    // Format based on tool type to match extract-command-messages.ts
    switch (toolName) {
      case 'shell': {
        const command = normalizedArgs.command ?? normalizedArgs.commands;

        const commandText = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' && ') : '';

        if (typeof commandText === 'string' && commandText.trim()) {
          return commandText.length > 80 ? `${commandText.slice(0, 80)}...` : commandText;
        }
        return '';
      }

      case 'grep': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        const parts = [`for "${pattern}" in "${path}"`];
        if (normalizedArgs.fixed_strings) parts.push('--fixed-strings');
        if (normalizedArgs.ignore_case) parts.push('--ignore-case');
        if (normalizedArgs.include) parts.push(`--include "${normalizedArgs.include}"`);
        if (normalizedArgs.exclude) parts.push(`--exclude "${normalizedArgs.exclude}"`);
        return parts.join(' ');
      }

      case 'read_file':
      case 'view_file': {
        const path = normalizedArgs.path || 'unknown';
        const start = normalizedArgs.start_line;
        const end = normalizedArgs.end_line;
        if (start !== undefined || end !== undefined) {
          return `"${path}" (lines ${start ?? 1}-${end ?? 'end'})`;
        }
        return `"${path}"`;
      }

      case 'glob': {
        const pattern = normalizedArgs.pattern || '';
        const path = normalizedArgs.path || '.';
        if (path !== '.' && path) {
          return `matching "${pattern}" in "${path}"`;
        }
        return `matching "${pattern}"`;
      }

      case 'run_subagent': {
        const role = normalizedArgs.role || 'subagent';
        const task = normalizedArgs.task || '';
        const taskPreview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
        return `[${role}] "${taskPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'web_search': {
        const query = normalizedArgs.query || '';
        return `for "${query}"`;
      }

      case 'web_fetch': {
        const url = normalizedArgs.url || '';
        return `"${url}"`;
      }

      case 'ask_mentor': {
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'ask_user': {
        const questions = normalizedArgs.questions;
        if (Array.isArray(questions) && questions.length > 0) {
          const qList = questions.map((q: any) => q?.question).filter(Boolean);
          if (qList.length === 1) {
            const question = qList[0];
            const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
            return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
          } else if (qList.length > 1) {
            const joined = qList.join(', ');
            const qPreview = joined.length > 40 ? `${joined.slice(0, 40)}...` : joined;
            return `["${qPreview.replace(/\r?\n/g, ' ')}"]`;
          }
        }
        const question = normalizedArgs.question || 'Unknown question';
        const qPreview = question.length > 40 ? `${question.slice(0, 40)}...` : question;
        return `"${qPreview.replace(/\r?\n/g, ' ')}"`;
      }

      case 'read_code_outline': {
        const path = normalizedArgs.path || 'unknown';
        return `of "${path}"`;
      }

      case 'code_context_search': {
        const queryType = normalizedArgs.query_type;
        if (queryType === 'symbol') {
          return `for symbol "${normalizedArgs.symbol || ''}"`;
        }
        return `for files related to "${normalizedArgs.path || ''}"`;
      }

      case TOOL_NAME_APPLY_PATCH: {
        const type = normalizedArgs.type || 'unknown';
        const path = normalizedArgs.path || 'unknown';
        return `${type} ${path}`;
      }

      case TOOL_NAME_SEARCH_REPLACE: {
        const path = normalizedArgs.path || 'unknown';
        if (displayMode === 'concise') {
          if (normalizedArgs.replacements) {
            const replacements = normalizedArgs.replacements || [];
            const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
            return `"${path}"${countText}`;
          } else {
            return `"${path}"`;
          }
        }
        if (normalizedArgs.replacements) {
          const replacements = normalizedArgs.replacements || [];
          const firstRep = replacements[0] || {};
          const searchContent = firstRep.search_content || '';
          const replaceContent = firstRep.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          const countText = replacements.length > 1 ? ` (+ ${replacements.length - 1} more)` : '';
          return `"${search}" → "${replace}" "${path}"${countText}`;
        } else {
          const searchContent = normalizedArgs.search_content || '';
          const replaceContent = normalizedArgs.replace_content || '';
          const search = searchContent.length > 30 ? `${searchContent.slice(0, 30)}...` : searchContent;
          const replace = replaceContent.length > 30 ? `${replaceContent.slice(0, 30)}...` : replaceContent;
          return `"${search}" → "${replace}" "${path}"`;
        }
      }

      case TOOL_NAME_CREATE_FILE: {
        const filePath = normalizedArgs.path || 'unknown';
        return `"${filePath}"`;
      }

      default: {
        // Generic fallback for unknown tools
        const entries = Object.entries(normalizedArgs);
        if (entries.length === 0) return '';

        return entries
          .map(([key, value]) => {
            const stringValue =
              typeof value === 'string'
                ? value.length > 50
                  ? `${value.slice(0, 50)}...`
                  : value
                : JSON.stringify(value);
            return `${key}=${stringValue}`;
          })
          .join(' ');
      }
    }
  } catch {
    return '';
  }
};

export const countDiffStats = (diff: string): DiffStats => {
  let added = 0;
  let removed = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }
  }

  return { added, removed };
};
