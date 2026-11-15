/**
 * How an `apply_patch` call is described on screen: the one-line summary behind a
 * CommandMessage row and the paged preview the approval prompt shows.
 *
 * Both accept the canonical `{ patch }` envelope (a freeform script parsed by
 * shared/utils/upstream-apply-patch.ts) or the legacy `{ operations }` object
 * shape, so the transcript and the approval prompt never disagree about which
 * files a call touches.
 */
import { parseUpstreamApplyPatch } from '../../../../shared/utils/upstream-apply-patch.js';

type ApplyPatchOperation = {
  type: 'create_file' | 'update_file' | 'delete_file';
  path: string;
  diff?: string;
  moveTo?: string;
};

const OPERATION_LABELS: Record<ApplyPatchOperation['type'], string> = {
  create_file: 'CREATE',
  update_file: 'UPDATE',
  delete_file: 'DELETE',
};

/** Preview lines shown per page; the approval prompt pages with `[` and `]`. */
export const APPLY_PATCH_PREVIEW_PAGE_LINES = 4;

const isOperation = (value: unknown): value is ApplyPatchOperation => {
  const op = value as Record<string, unknown> | null;
  return (
    !!op &&
    typeof op === 'object' &&
    (op.type === 'create_file' || op.type === 'update_file' || op.type === 'delete_file') &&
    typeof op.path === 'string' &&
    (op.diff === undefined || typeof op.diff === 'string') &&
    (op.moveTo === undefined || typeof op.moveTo === 'string')
  );
};

const operationsFromArgs = (args: Record<string, unknown> | null): ApplyPatchOperation[] | null => {
  if (typeof args?.patch === 'string') return parseUpstreamApplyPatch(args.patch).operations;
  const candidates = Array.isArray(args?.operations) ? args.operations : [args];
  return candidates.every(isOperation) ? (candidates as ApplyPatchOperation[]) : null;
};

/** `update_file src/a.ts → src/b.ts (+ 2 more)`: the first operation and how many follow. */
export function applyPatchArgsSummary(args: Record<string, any>): string {
  let operations: ApplyPatchOperation[];
  try {
    operations = operationsFromArgs(args) ?? [args as ApplyPatchOperation];
  } catch {
    return 'invalid patch';
  }
  const first = operations[0] ?? ({} as ApplyPatchOperation);
  const path = `${first.type || 'unknown'} ${first.path || 'unknown'}`;
  const move = first.moveTo ? ` → ${first.moveTo}` : '';
  const more = operations.length > 1 ? ` (+ ${operations.length - 1} more)` : '';
  return `${path}${move}${more}`;
}

function previewLines(argumentsText: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(argumentsText);
    const operations = operationsFromArgs(value as Record<string, unknown> | null);
    if (!operations?.length) throw new Error('Unknown patch input');
    return operations.flatMap((op) => [
      `[${OPERATION_LABELS[op.type]}] ${op.path}${op.moveTo ? ` → ${op.moveTo}` : ''}`,
      ...(op.diff ? op.diff.split('\n') : []),
    ]);
  } catch {
    // Show the complete input, not a misleading partial parse.
    return [
      '[Raw patch input]',
      ...(typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : argumentsText).split('\n'),
    ];
  }
}

/** Preview lines already escaped and wrapped to the prompt's diff column. */
export function applyPatchPreviewLines(argumentsText: string, columns: number): string[] {
  const width = Math.max(1, Math.floor((columns - 12) / 2));
  return previewLines(argumentsText).flatMap((line) => {
    const safe = line.replace(
      /[\x00-\x1f\x7f-\x9f]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    const chars = Array.from(safe);
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += width) chunks.push(chars.slice(i, i + width).join(''));
    return chunks.length ? chunks : [''];
  });
}
