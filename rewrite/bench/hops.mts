// Count the modules one user message passes through between Session submit and
// the provider call, and fail when that path grows past the recorded budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHook, executionAsyncId } from 'node:async_hooks';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const budget = JSON.parse(
  fs.readFileSync(path.join(repo, 'rewrite/scripts/complexity-budget.json'), 'utf8'),
).messagePath;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-hops-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);

// Async stack traces stop at detached launches, so follow the async resource
// chain from the provider call back to submit and join each creation stack.
Error.stackTraceLimit = 200;
const created = new Map<number, { trigger: number; stack: string }>();
const hook = createHook({
  init(id, _type, trigger) {
    created.set(id, { trigger, stack: new Error().stack ?? '' });
  },
});
let stack: string | undefined;
const causalStack = () => {
  const stacks = [new Error('provider call').stack ?? ''];
  for (let id = executionAsyncId(), seen = 0; created.has(id) && seen < 10000; seen++) {
    const entry = created.get(id)!;
    stacks.push(entry.stack);
    id = entry.trigger;
  }
  return stacks
    .reverse()
    .map((frames) => frames.split('\n').reverse().join('\n'))
    .join('\n');
};
const provider: any = {
  id: 'openai',
  label: 'fixture',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream() {
        stack ??= causalStack();
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          responseId: 'fixture',
        };
      },
    };
  },
};
const providers = createProviderRegistry();
providers.upsertProvider(provider);
const { service: host, source } = createAdoptedSettings({
  disableLogging: true,
  disableFilePersistence: true,
  cli: {
    agent: {
      modelSelection: { provider: 'openai', model: 'fixture' },
      contextCompaction: { enabled: false },
      runBudget: { escalation: 'disabled' },
      retryAttempts: 0,
    } as any,
    memory: { enabled: false } as any,
  },
});
const pair = source.forSessionBinding({ readable: Object.keys(host.getAll()) as any, writable: [] });
const logger = new LoggingService({ disableLogging: true });
const models = createAdoptedModelRegistry({
  settingsService: pair.service,
  loggingService: logger,
  sessionContextService: new SessionContextService(),
  providerRegistry: providers,
  ownership: 'borrowed',
});
const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
let ownership: ToolOwnershipRegistry;
let graphContext: SessionContextService;
const store = new LocalSessionStore({
  root: path.join(root, 'sessions'),
  logger,
  defaultWorkspace: workspaceConfig,
  defaultModel: modelRef,
  driverFactory: () => {
    throw new Error('combined handle expected');
  },
  adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
    engine: () => {
      ownership = new ToolOwnershipRegistry();
      graphContext = new SessionContextService();
      const execution = new ExecutionContext();
      execution.enterWorkspace(workspace);
      return {
        models,
        settings: pair.settings,
        clientOptions: {
          selection: { provider: 'openai', model: 'fixture' },
          toolOwnership: ownership,
          deps: { settings: pair.service, logger, sessionContextService: graphContext, executionContext: execution },
        },
      };
    },
    runtime: () => ({
      toolOwnership: ownership,
      deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
    }),
  }),
});

const { session, submission } = await store.createAdopted(workspaceConfig, modelRef);
hook.enable();
try {
  await submission.submit({ requestId: 'hops', input: { text: 'hello' } });
  const until = Date.now() + 10000;
  while (!stack) {
    if (Date.now() > until) throw new Error('provider was never called');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} finally {
  hook.disable();
  await session.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}

// Outermost caller first; consecutive frames in one file are one hop.
const files: string[] = [];
for (const line of stack!.split('\n')) {
  const match = /\(?((?:file:\/\/)?\/[^():]+\.m?tsx?):\d+:\d+\)?$/.exec(line.trim());
  if (!match) continue;
  const file = path.relative(repo, match[1]!.replace(/^file:\/\//, ''));
  if (file.startsWith('..') || file.includes('node_modules') || file.startsWith('rewrite/bench/')) continue;
  if (files.at(-1) !== file) files.push(file);
}
const distinct = [...new Set(files)];
const sourceFiles = distinct.filter((file) => file.startsWith('source/'));
const layerOf = (file: string) => /^rewrite\/src\/([^/]+)\//.exec(file)?.[1] ?? 'source';
const layers = files.map(layerOf).filter((layer, index, all) => layer !== all[index - 1]);

console.log(`message path: ${files.length} hops through ${distinct.length} files (${sourceFiles.length} in source/)`);
console.log(`layers: ${layers.join(' -> ')}`);
for (const file of files) console.log(`  ${file}`);
assert.ok(files.length > 0, 'stack trace named no repository files');
assert.ok(
  files.length <= budget.maxHops,
  `message path grew to ${files.length} hops (budget ${budget.maxHops}); simplify the path or justify raising the budget`,
);
assert.ok(
  distinct.length <= budget.maxFiles,
  `message path touches ${distinct.length} files (budget ${budget.maxFiles})`,
);
if (files.length < budget.maxHops || distinct.length < budget.maxFiles)
  console.log(
    `path is under budget: lower messagePath to { maxHops: ${files.length}, maxFiles: ${distinct.length} } in rewrite/scripts/complexity-budget.json`,
  );
console.log('PASS message path within budget');
