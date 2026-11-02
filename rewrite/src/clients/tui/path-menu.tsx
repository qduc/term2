import React, { useEffect, useState } from 'react';
import type { Key } from 'ink';
import { listWorkspacePaths, type WorkspacePath } from './workspace-paths.js';
import { Box, Text } from 'ink';

/** Rows of paths shown at once. The menu (rows, status lines and hint) is up to 7 lines; like the slash menu it is not part of the transcript viewport's reserve. */
const VISIBLE = 5;

/** Substring match, ranked: basename prefix, basename substring, then path substring. No looser matching: a draft that ends in an ordinary `@word` should find nothing, so Enter still sends it. */
function rank(entries: readonly WorkspacePath[], query: string, limit: number): WorkspacePath[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries.slice(0, limit);
  const scored = entries.flatMap((entry) => {
    const lower = entry.path.toLowerCase();
    const base = lower.slice(lower.replace(/\/$/, '').lastIndexOf('/') + 1);
    const score = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1;
    return score < 0 ? [] : [{ entry, score }];
  });
  return scored
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** The text that replaces `@query`: directories end with `/`, and Enter adds a space. */
function insertion(value: string, start: number, cursor: number, entry: WorkspacePath, space: boolean) {
  // A directory keeps its `@` and ends with `/`, so the menu stays open to continue inside it.
  const directory = entry.type === 'directory';
  const shown = directory ? `@${entry.path}/` : entry.path;
  const padding = space && !directory ? ' ' : '';
  const before = value.slice(0, start);
  const text = `${before}${shown}${padding}${value.slice(Math.min(cursor, value.length))}`;
  return { text, cursor: before.length + shown.length + padding.length };
}

/** `@` before the cursor, at the start of the text or after whitespace, with the query typed so far. */
export function findPathTrigger(value: string, cursor: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, Math.min(cursor, value.length)));
  return match ? { start: match.index + match[1]!.length, query: match[2]! } : null;
}

/**
 * `@` file-path completion for the composer. Enter and Tab insert the selected path (Enter adds a space,
 * Tab does not), arrows select, Escape dismisses. Same contract as the slash menu so the session treats them alike.
 */
export function usePathMenu(value: string, enabled: boolean, subtle: React.ComponentProps<typeof Text>['color']) {
  // The app starts in the workspace; paths are relative to it.
  const root = process.cwd();
  const [entries, setEntries] = useState<WorkspacePath[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The cursor position is not tracked in render state, so the menu works on the end of the draft.
  const cursor = value.length;
  const trigger = enabled ? findPathTrigger(value, cursor) : null;
  const open = trigger !== null && value !== dismissed;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listWorkspacePaths(root).then(
      (loaded) => !cancelled && (setEntries(loaded.entries), setTruncated(loaded.truncated)),
      (failure) => !cancelled && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, root]);
  const matches = open && entries ? rank(entries, trigger!.query, 50) : [];
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  const owns = (key: Key) =>
    open &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    (key.escape || (matches.length > 0 && (key.upArrow || key.downArrow || key.tab || key.return)));
  const handle = (key: Key, apply: (text: string, cursor: number) => void) => {
    if (!owns(key)) return false;
    if (key.escape) setDismissed(value);
    else if (key.upArrow || key.downArrow)
      setIndex((selected + (key.upArrow ? matches.length - 1 : 1)) % matches.length);
    else {
      const entry = matches[selected];
      if (entry) {
        const next = insertion(value, trigger!.start, cursor, entry, Boolean(key.return));
        apply(next.text, next.cursor);
      }
      setIndex(0);
    }
    return true;
  };
  const reset = () => {
    setIndex(0);
    setDismissed(null);
  };
  const first = Math.max(0, selected - VISIBLE + 1);
  const view = open ? (
    <Box flexDirection="column">
      {error ? <Text color={subtle}>Unable to load paths: {error}</Text> : null}
      {entries === null && !error ? <Text color={subtle}>Loading project paths…</Text> : null}
      {entries && matches.length === 0 ? <Text color={subtle}>No matches for "@{trigger!.query}"</Text> : null}
      {matches.slice(first, first + VISIBLE).map((entry, row) => (
        <Text key={entry.path} wrap="truncate-start">
          {first + row === selected ? '› ' : '  '}
          {entry.type === 'directory' ? `${entry.path}/` : entry.path}
        </Text>
      ))}
      {truncated ? <Text color={subtle}>Path list is truncated (large repo).</Text> : null}
      <Text color={subtle}>↑/↓ select · Enter insert · Tab insert without space · Esc dismiss</Text>
    </Box>
  ) : null;
  return { owns, handle, reset, view };
}
