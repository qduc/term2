import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createRunCodeToolDefinition } from './run-code.js';
import { createReadFileToolDefinition } from '../../file/read-file.js';
import { createGrepToolDefinition } from '../../file/grep.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { ToolRegistry } from '../../types.js';
import { createFindFilesToolDefinition } from '../../file/glob.js';
import { trimToolOutput } from '../../../utils/output/trim-tool-output.js';
import { isScriptedToolCall } from '../../../utils/output/bound-tool-result.js';

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
                 return { length: r.content.length, lines: r.content.split('\\n').length };`,
        timeout_ms: 60_000,
      } as never),
    );

    const lines = Number(/"lines":(\d+)/.exec(output)?.[1]);
    expect(output).not.toContain('Script failed');
    // The script must see every line, not a 40,000-byte prefix. The scripted
    // shape carries raw lines, so there is no banner to account for.
    expect(lines).toBe(raw.split('\n').length);
  });
});

describe('structured scripted results survive the tool wrapper', () => {
  it('delivers fields to the script, not the string "[object Object]"', async () => {
    const glob = createFindFilesToolDefinition({
      executionContext: {
        getCwd: () => process.cwd(),
        isRemote: () => false,
        getSSHService: () => undefined,
      } as never,
    }) as any;

    // The agent factory wraps every definition; trimToolOutput there coerces a
    // non-string result with String(), which turned structured returns into
    // "[object Object]" for every script that called them.
    const wrapped = {
      ...glob,
      execute: async (p: unknown, c: unknown, d: unknown) => {
        const result = await glob.execute(p, c, d);
        return isScriptedToolCall(c) ? result : trimToolOutput(result, undefined, undefined);
      },
    };

    const direct = await wrapped.execute({ pattern: 'source/tools/file/*.ts' }, {}, undefined);
    const scripted: any = await wrapped.execute({ pattern: 'source/tools/file/*.ts' }, { scripted: true }, undefined);

    // String() of a correct object is also "[object Object]", so assert the
    // fields survived rather than the stringification.
    expect(typeof direct).toBe('string');
    expect(typeof scripted).toBe('object');
    expect(Array.isArray(scripted.paths)).toBe(true);
    expect(scripted.paths.length).toBeGreaterThan(0);
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
