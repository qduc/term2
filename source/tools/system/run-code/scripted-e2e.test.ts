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
import { createSessionBrowserToolDefinitions } from '../../session-browser/session-browser-tools.js';
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
  }, 30_000);
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
  }, 30_000);
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
  }, 30_000);
});

describe('run_code -> session tools return structured values on the scripted path', () => {
  const browserEnvelope = {
    sessions: [
      {
        id: 'abc123',
        shortRef: 'abc123',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        firstUserMessage: 'first',
        messageCount: 2,
      },
    ],
    scope: 'project',
    total: 1,
    omitted: 0,
    unavailable: 0,
    charsUsed: 200,
  };
  const browser = {
    list: () => browserEnvelope,
    search: () => ({
      results: [],
      scope: 'project',
      total: 0,
      omitted: 0,
      unavailable: 0,
      skippedMessageCount: 0,
      charsUsed: 100,
    }),
    read: () => ({
      scope: 'project',
      session: { id: 'abc123' },
      items: [],
      total: 0,
      omitted: 0,
      skippedMessageCount: 0,
      charsUsed: 120,
    }),
  };

  const buildRunCode = () => {
    const sessionTools = createSessionBrowserToolDefinitions(browser as never);
    const registry = sessionTools as ToolRegistry;
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    for (const tool of sessionTools) {
      approvalPolicyRegistry.register({
        toolName: tool.name,
        parameters: tool.parameters,
        needsApproval: tool.needsApproval,
      });
    }
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
    return { runCode, registry };
  };

  it('delivers envelope fields to the script, not a JSON string it must parse', async () => {
    const { runCode } = buildRunCode();
    const output = String(
      await runCode.execute({
        code: `const r = await tools.session_list({ limit: 5 });
               return {
                 isString: typeof r === 'string',
                 keys: r && typeof r === 'object' ? Object.keys(r).sort() : null,
                 firstSessionId: r.sessions?.[0]?.id ?? null,
                 total: r.total,
               };`,
        timeout_ms: 60_000,
      } as never),
    );

    expect(output).not.toContain('Script failed');
    expect(output).toContain('"isString":false');
    expect(output).toContain('"firstSessionId":"abc123"');
    expect(output).toContain('"total":1');
  }, 30_000);

  it('keeps the direct-call output format a serialized JSON string', async () => {
    const { registry } = buildRunCode();
    const list = registry.find((tool) => tool.name === 'session_list')!;
    const direct = String(await list.execute({ limit: 5 }, {}, undefined));
    expect(JSON.parse(direct)).toEqual(browserEnvelope);
  });
});
