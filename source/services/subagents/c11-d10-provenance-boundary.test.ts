import { it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
} from './test-helpers/subagent-manager-fixtures.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = createTempDir('c11-d10-boundary-');
});

afterEach(() => {
  removeTempDir(tmpDir);
});

// C11-D10 `require_interactive_equivalent_provenance`: non-interactive Yellow-risk
// approval must carry interactive-equivalent provenance (risk, authority, confidence,
// source). The worker path currently accepts a metadata-less positive advisory.
// Ordinary form observed failure: the shell tool executes (no blocked-for-safety error)
// even though the advisory carried no provenance.
it.fails(
  'rejects a metadata-less non-interactive YELLOW approval without interactive-equivalent provenance (C11-D10)',
  async () => {
    let shellResult: string | null = null;

    const providerId = registerTestProvider({
      label: 'C11 D10 Metadata-less Yellow Provider',
      createStreamedModel: () =>
        ({
          stream: async function* (request: any) {
            const shellTool = request.applicationTools.find((tool: any) => tool.name === 'shell');
            shellResult = await shellTool.execute(
              JSON.stringify({ command: 'npm run test:verbose -- --help' }),
              {},
              {},
            );
            const result = {
              status: 'completed',
              finalOutput: 'done',
              history: [],
              messages: [],
            };
            yield* wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': providerId,
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'mock-auto-approve-model',
        'agent.autoApproveProvider': providerId,
        'sandbox.enabled': false,
      }),
      sessionContextService: createSessionContextService() as any,
      agentClient: {
        chat: async () => '{"results":[{"approved":true,"reasoning":"Looks related and low risk."}]}',
      } as any,
      executionContext: createMockExecutionContext(tmpDir),
    });

    await manager.run({ role: 'worker', task: 'run help for tests in this repository' });

    expect(shellResult).toBeTruthy();
    expect(shellResult!.includes('blocked for safety')).toBe(true);
  },
);
