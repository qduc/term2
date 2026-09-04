import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createRunCodeToolDefinition } from './run-code.js';
import { createReadFileToolDefinition } from '../../file/read-file.js';
import { createGrepToolDefinition } from '../../file/grep.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { ToolRegistry } from '../../types.js';

describe('run_code -> read_file scripted cap, end to end', () => {
  it('delivers the whole file to the script through the real dispatch path', async () => {
    const readFile = createReadFileToolDefinition({}) as any;
    const registry = [readFile] as ToolRegistry;
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    approvalPolicyRegistry.register({
      toolName: readFile.name,
      parameters: readFile.parameters,
      needsApproval: readFile.needsApproval,
    });

    const runCode = createRunCodeToolDefinition({
      loggingService: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        security: vi.fn(),
      } as unknown as ILoggingService,
      getToolRegistry: () => registry,
      getCwd: () => process.cwd(),
      approvalPolicyRegistry,
    });

    const raw = await fs.readFile('source/tools/system/shell.ts', 'utf8');
    const output = String(
      await runCode.execute({
        code: `const r = await tools.read_file({ path: 'source/tools/system/shell.ts' });
                 return { length: r.length, lines: r.split('\\n').length };`,
        timeout_ms: 60_000,
      } as never),
    );

    const lines = Number(/"lines":(\d+)/.exec(output)?.[1]);
    expect(output).not.toContain('Script failed');
    // The script must see every line, not a 40,000-byte prefix. read_file
    // prepends a two-line header ("File: ... (N lines)" and a "===" rule).
    expect(lines).toBe(raw.split('\n').length + 2);
  });
});

describe('run_code -> grep scripted cap, end to end', () => {
  it('delivers every match to the script through the real dispatch path, not just 50', async () => {
    const grep = createGrepToolDefinition() as any;
    const registry = [grep] as ToolRegistry;
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    approvalPolicyRegistry.register({
      toolName: grep.name,
      parameters: grep.parameters,
      needsApproval: grep.needsApproval,
    });

    const runCode = createRunCodeToolDefinition({
      loggingService: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        security: vi.fn(),
      } as unknown as ILoggingService,
      getToolRegistry: () => registry,
      getCwd: () => process.cwd(),
      approvalPolicyRegistry,
    });

    // Written inside the workspace (not system tmp) so grep's approval check
    // sees an in-bounds path and does not prompt.
    const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-scripted-grep-'));
    try {
      const total = 120;
      const lines = Array.from({ length: total }, (_, i) => `needle line ${i}`).join('\n');
      await fs.writeFile(path.join(dir, 'haystack.txt'), `${lines}\n`);
      const relDir = path.relative(process.cwd(), dir);

      const output = String(
        await runCode.execute({
          code: `const r = await tools.grep({ pattern: 'needle', path: ${JSON.stringify(relDir)} });
                   const matches = r.split('\\n').filter((line) => line.includes('needle'));
                   return { count: matches.length, hasNote: r.includes('lines exceed') };`,
          timeout_ms: 60_000,
        } as never),
      );

      expect(output).not.toContain('Script failed');
      const count = Number(/"count":(\d+)/.exec(output)?.[1]);
      // The script must see every match, not the 50-line default that
      // exists to protect model context it never reaches.
      expect(count).toBe(total);
      expect(output).toContain('"hasNote":false');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
