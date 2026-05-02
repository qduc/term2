import { dirname, extname, join, basename } from 'node:path';

export const EVAL_CACHE_VERSION = 'auto-approval-evaluator-v2';

export function getReportPath(outputPath: string): string {
  const extension = extname(outputPath);
  if (extension === '.json') {
    return outputPath.slice(0, -extension.length) + '.md';
  }

  return join(dirname(outputPath), `${basename(outputPath)}.md`);
}

export function validateRunnerOptions({ concurrency, repeat }: { concurrency: number; repeat: number }): void {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('--concurrency must be an integer greater than or equal to 1');
  }

  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error('--repeat must be an integer greater than or equal to 1');
  }
}

export function createCacheKey({
  model,
  provider,
  command,
  history,
}: {
  model: string;
  provider: string;
  command: string;
  history: unknown;
}): Record<string, unknown> {
  return {
    version: EVAL_CACHE_VERSION,
    model,
    provider,
    command,
    history,
  };
}
