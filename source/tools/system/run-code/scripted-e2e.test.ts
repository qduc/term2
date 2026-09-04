import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import { createRunCodeToolDefinition } from './run-code.js';
import { createReadFileToolDefinition } from '../../file/read-file.js';
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
