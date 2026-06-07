const TOOL_NAME_GREP = 'grep' as const;
const TOOL_NAME_FIND_FILES = 'find_files' as const;

export type SearchKind = 'grep' | 'find_files' | 'shell';

const SEARCH_TOOL_NAMES = new Set<string>([TOOL_NAME_GREP, TOOL_NAME_FIND_FILES]);

const SEARCH_COMMANDS = ['grep', 'rg', 'find', 'fd', 'ag', 'ack', 'git grep'];

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
  const lines = output.split('\n');
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
  if (toolName === TOOL_NAME_FIND_FILES) return 'find_files';

  void command;
  return 'shell';
};

export const getMatchCount = (toolName: string | undefined, command: string, output: string | undefined): number => {
  if (!output) return 0;

  const searchKind = classifySearchKind(toolName, command);
  if (searchKind === 'grep') {
    const parsed = parseGrepOutput(output);
    if (parsed) {
      return Object.values(parsed.matchesByFile).reduce((acc, matches) => acc + matches.length, 0);
    }
  } else if (searchKind === 'find_files') {
    const parsed = parseFindFilesOutput(output);
    if (parsed) {
      return parsed.files.length;
    }
  }

  // Shell fallback: count visible result lines when the tool is a shell-routed search
  // or the structured parsers cannot decode the output. These skip rules mirror the
  // dedicated parsers above, but they still intentionally overcount unfamiliar summaries.
  let count = 0;
  for (let line of output.split('\n')) {
    line = line.trim();
    if (!line) continue;
    if (
      line.startsWith('Note:') ||
      line.startsWith('Error:') ||
      line.startsWith('grep: ') ||
      line.startsWith('rg: ') ||
      line.startsWith('find: ') ||
      line === '--'
    ) {
      continue;
    }
    count++;
  }
  return count;
};
