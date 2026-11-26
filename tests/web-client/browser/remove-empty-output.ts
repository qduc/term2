import fs from 'node:fs';
import type { Reporter } from '@playwright/test/reporter';

/**
 * A passing run leaves nothing behind. Playwright keeps its output directory even when it holds only
 * the last-run marker, which is written after global teardown, so this runs as the last reporter step.
 * A failing run keeps the directory, because it holds the evidence.
 */
export default class RemoveEmptyOutput implements Reporter {
  printsToStdio(): boolean {
    return false;
  }

  async onExit(): Promise<void> {
    const output = process.env.TERM2_WEB_FLOW_OUTPUT;
    if (!output || !fs.existsSync(output)) return;
    const evidence = fs.readdirSync(output).filter((name) => name !== '.last-run.json');
    if (evidence.length === 0) fs.rmSync(output, { recursive: true, force: true });
    else console.error(`[web flows] failure evidence kept in ${output}`);
  }
}
