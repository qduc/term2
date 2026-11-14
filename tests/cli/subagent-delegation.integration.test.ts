// run_subagent through the built CLI against a loopback chat-completions double: what the model
// sends, what the child receives, and how many root requests a delegation costs.
import { it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';
import { integrationCliPath as cliPath } from '../helpers/integration-cli.js';

type Body = {
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
  tools?: { function: { name: string; parameters?: unknown } }[];
};
type Reply = { frames: unknown[]; delayMs?: number };
type Seen = { body: Body; root: boolean; startedAt: number; endedAt?: number };

let home = '';
let workspace = '';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-deleg-')));
  workspace = path.join(home, 'ws');
  fs.mkdirSync(path.join(workspace, 'scratch', 'term2-nodejs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });
});

afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const text = (content: string): Reply => ({
  frames: [
    { id: 'f', choices: [{ delta: { role: 'assistant', content } }] },
    { id: 'f', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ],
});
const calls = (...list: { name: string; args: unknown }[]): Reply => ({
  frames: [
    {
      id: 'f',
      choices: [
        {
          delta: {
            tool_calls: list.map((call, index) => ({
              index,
              id: `call-${index}-${call.name}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
    },
    { id: 'f', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
});

/** Root requests offer run_subagent; child requests (explorer, librarian) do not. */
async function startProvider(script: (seen: Seen, rootIndex: number) => Reply) {
  const seen: Seen[] = [];
  let roots = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Body;
      const root = Boolean(body.tools?.some((tool) => tool.function.name === 'run_subagent'));
      const entry: Seen = { body, root, startedAt: Date.now() };
      seen.push(entry);
      const reply = script(entry, root ? ++roots : 0);
      const send = () => {
        if (res.destroyed) return;
        entry.endedAt = Date.now();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([...reply.frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const settingsDir = resolveSettingsDirectory({ homeDir: home });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      app: { activeProfileId: 'builtin:standard' },
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
      ],
    }),
  );
  return { seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const scratch = path.join(workspace, 'scratch', 'term2-nodejs');
  const child = spawn('node', [cliPath(), '--profile', 'standard', ...args], {
    cwd: workspace,
    env: {
      ...createTestChildEnv({
        HOME: home,
        TERM2_CONVERSATIONS_DIR: path.join(home, 'conversations'),
        DISABLE_LOGGING: '1',
      }),
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (part as { text?: string }).text ?? '').join('')
    : '';
const toolResults = (body: Body) => body.messages.filter((m) => m.role === 'tool').map((m) => contentText(m.content));
const userText = (body: Body) =>
  body.messages
    .filter((m) => m.role === 'user')
    .map((m) => contentText(m.content))
    .join('\n');
const runSubagentCalls = (seen: Seen[]) => seen.filter((s) => s.root).flatMap((s) => toolResults(s.body)).length;

it('runs a role call that also carries an agent_spec as that role, and says so in the result', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return text('Child evidence: parseInvoice is in src/a.js:2');
    if (rootIndex === 1)
      return calls({
        name: 'run_subagent',
        args: {
          execution: 'background',
          role: 'explorer',
          agent_spec: {
            goal: 'Find where parseInvoice is defined',
            constraints: ['Read-only: do not modify files.'],
            doneWhen: 'The defining file is reported with a line number.',
            tools: ['grep', 'glob', 'read_file'],
          },
        },
      });
    return text(rootIndex === 2 ? 'Waiting for the explorer.' : 'parseInvoice is defined in src/a.js.');
  });
  try {
    const result = await runCli(['Find parseInvoice']);
    expect(result.status, result.stderr).toBe(0);
    const roots = provider.seen.filter((s) => s.root);
    const children = provider.seen.filter((s) => !s.root);
    // Launch, wait, completion notification: no request spent on a rejected call and its retry.
    expect(roots).toHaveLength(3);
    expect(children).toHaveLength(1);
    const launch = JSON.parse(toolResults(roots[1]!.body)[0]!) as Record<string, unknown>;
    expect(launch).toMatchObject({ status: 'running' });
    expect(launch.interpretation).toBe(
      'Read as role "explorer" with task; agent_spec was not launched; appended to the task: goal (as the task), ' +
        "constraints, doneWhen; ignored (the role's own tools and limits apply): tools.",
    );
    const childTask = userText(children[0]!.body);
    expect(childTask).toContain('Find where parseInvoice is defined');
    expect(childTask).toContain('Constraints:\n- Read-only: do not modify files.');
    expect(childTask).toContain('Done when: The defining file is reported with a line number.');
    // The role preset ran: its own tools (web and shell), not the spec's three-tool list.
    const childTools = children[0]!.body.tools!.map((tool) => tool.function.name);
    expect(childTools).toEqual(expect.arrayContaining(['shell', 'web_search', 'grep']));
    expect(userText(roots[2]!.body)).toContain('Child evidence: parseInvoice is in src/a.js:2');
  } finally {
    await provider.close();
  }
});

// Each call would lose something the model asked for if rewritten to role + task: a writing role's
// scope, a model choice, a grant to create agents, or a tool the role lacks. All are refused.
it('rejects role calls whose agent_spec or top-level fields the role cannot honour, naming the shape to send', async () => {
  const refused: [args: Record<string, unknown>, reason: string][] = [
    [
      { role: 'explorer', agent_spec: { goal: 'Edit a.js', tools: ['apply_patch'] } },
      'apply_patch, which explorer lacks',
    ],
    [
      { role: 'explorer', task: 'Find a', agent_spec: { goal: 'Find a', model: 'capable' } },
      'model is not used by role',
    ],
    [
      { role: 'explorer', agent_spec: { goal: 'Find a', permissions: { agents: { create: true } } } },
      'permissions.agents would not be enforced',
    ],
    [
      { role: 'explorer', agent_spec: { goal: 'Find a', permissions: { filesystem: { read: ['src'] } } } },
      'permissions.filesystem would not be enforced',
    ],
    [{ role: 'explorer', task: 'Find a', tools: ['create_file'] }, 'create_file, which explorer lacks'],
    [
      { role: 'worker', task: 'Edit a.js', agent_spec: { goal: 'Edit a.js', permissions: { readOnly: true } } },
      'role worker is not combined with agent_spec',
    ],
    [{ role: 'worker', task: 'Edit a.js', doneWhen: 'a.js is edited' }, 'role worker is not combined with doneWhen'],
  ];
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return text('unexpected child');
    if (rootIndex === 1)
      return calls(...refused.map(([args]) => ({ name: 'run_subagent', args: { execution: 'background', ...args } })));
    return text('Stopped.');
  });
  try {
    const result = await runCli(['Edit a.js']);
    expect(result.status, result.stderr).toBe(0);
    expect(provider.seen.filter((s) => !s.root)).toHaveLength(0);
    const rejections = toolResults(provider.seen.filter((s) => s.root)[1]!.body);
    expect(rejections).toHaveLength(refused.length);
    rejections.forEach((rejection, index) => {
      expect(rejection).toContain('Send role+task without agent_spec, or agent_spec alone');
      expect(rejection).toContain(refused[index]![1]);
      expect(rejection).not.toContain('Read as');
    });
  } finally {
    await provider.close();
  }
});

const explorer = (task: string, execution = 'foreground') => ({
  name: 'run_subagent',
  args: { execution, role: 'explorer', task },
});

function savedFacts(): Record<string, unknown>[] {
  const dir = path.join(home, 'conversations');
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'));
  if (!file) return [];
  return fs
    .readFileSync(path.join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((record) => (record.fact as Record<string, unknown> | undefined) ?? record);
}

it('returns a foreground explorer result as the tool result of the same root turn', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return text('Child evidence: parseInvoice is in src/a.js:2');
    if (rootIndex === 1) return calls(explorer('Find where parseInvoice is defined'));
    return text('parseInvoice is defined in src/a.js.');
  });
  try {
    const result = await runCli(['Find parseInvoice']);
    expect(result.status, result.stderr).toBe(0);
    const roots = provider.seen.filter((s) => s.root);
    // Launch and final answer: no waiting reply, no notification turn (the background path takes three).
    expect(roots).toHaveLength(2);
    expect(provider.seen.filter((s) => !s.root)).toHaveLength(1);
    const offered = roots[0]!.body.tools!.find((tool) => tool.function.name === 'run_subagent')!.function
      .parameters as { properties: { execution: { enum: string[] } } };
    expect(offered.properties.execution.enum).toEqual(['foreground', 'background']);
    const [toolResult] = toolResults(roots[1]!.body);
    expect(toolResult).toMatch(/^Status: completed\n\nChild evidence: parseInvoice is in src\/a\.js:2/);
    expect(toolResult).not.toContain('Assess it');
    expect(result.stdout).toContain('parseInvoice is defined in src/a.js.');
    expect(savedFacts().some((fact) => fact.type === 'background_notice_enqueued')).toBe(false);
  } finally {
    await provider.close();
  }
});

// Both calls are parallel-safe, but the direct CLI marks every policy-approved call `batched`
// (src/app/source-tools.ts approvalFor), and the engine runs batched calls one at a time. This
// pins the order and the results; it asserts no concurrency the CLI does not have.
it('runs two foreground explorers from one response and returns both results in call order', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) {
      const first = userText(entry.body).includes('alpha');
      return { ...text(first ? 'alpha evidence' : 'beta evidence'), delayMs: first ? 300 : 0 };
    }
    if (rootIndex === 1) return calls(explorer('Collect alpha'), explorer('Collect beta'));
    return text('Both collected.');
  });
  try {
    const result = await runCli(['Collect both']);
    expect(result.status, result.stderr).toBe(0);
    expect(provider.seen.filter((s) => !s.root)).toHaveLength(2);
    const roots = provider.seen.filter((s) => s.root);
    expect(roots).toHaveLength(2);
    const results = toolResults(roots[1]!.body);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('alpha evidence');
    expect(results[1]).toContain('beta evidence');
  } finally {
    await provider.close();
  }
});

it('refuses foreground for a writing role and keeps background launches for it', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return text('unexpected child');
    if (rootIndex === 1)
      return calls({ name: 'run_subagent', args: { execution: 'foreground', role: 'worker', task: 'Edit a.js' } });
    return text('Stopped.');
  });
  try {
    const result = await runCli(['Edit a.js']);
    expect(result.status, result.stderr).toBe(0);
    expect(provider.seen.filter((s) => !s.root)).toHaveLength(0);
    const refusal = JSON.parse(toolResults(provider.seen.filter((s) => s.root)[1]!.body)[0]!);
    expect(refusal).toMatchObject({ status: 'failed', error: { code: 'foreground_unavailable' } });
  } finally {
    await provider.close();
  }
});

it('routes a foreground child approval to the headless policy and returns the child result', async () => {
  const outside = path.join(home, 'outside.txt');
  fs.writeFileSync(outside, 'secret outside the workspace');
  let childRequests = 0;
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) {
      childRequests += 1;
      if (childRequests === 1) return calls({ name: 'read_file', args: { path: outside } });
      return text(`Child saw: ${toolResults(entry.body).join(' | ')}`);
    }
    if (rootIndex === 1) return calls(explorer('Read the outside file'));
    return text('Done.');
  });
  try {
    const result = await runCli(['Read the outside file']);
    expect(result.status, result.stderr).toBe(0);
    const facts = savedFacts();
    // The child's approval was a task interaction answered by the headless policy (deny without --auto-approve).
    expect(facts.some((fact) => fact.type === 'task_interaction_opened')).toBe(true);
    const childResult = toolResults(provider.seen.filter((s) => !s.root)[1]!.body).join('\n');
    expect(childResult).not.toContain('secret outside the workspace');
    const [toolResult] = toolResults(provider.seen.filter((s) => s.root)[1]!.body);
    expect(toolResult).toMatch(/^Status: completed\n\nChild saw: /);
  } finally {
    await provider.close();
  }
});

it('cancels a running foreground child with the root turn', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return { ...text('too late'), delayMs: 30_000 };
    if (rootIndex === 1) return calls(explorer('Take a long time'));
    return text('unexpected root request');
  });
  try {
    const running = runCli(['Start a long explorer']);
    await expect.poll(() => provider.seen.some((s) => !s.root), { timeout: 15_000 }).toBe(true);
    const started = Date.now();
    const pid = Number(
      fs
        .readdirSync('/proc')
        .filter((name) => /^\d+$/.test(name))
        .find((name) => {
          try {
            const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
            return cmd.includes(cliPath()) && cmd.includes('Start a long explorer');
          } catch {
            return false;
          }
        }),
    );
    process.kill(pid, 'SIGINT');
    const result = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.status).not.toBe(0);
    expect(provider.seen.filter((s) => s.root)).toHaveLength(1);
    const finished = savedFacts().find((fact) => fact.type === 'task_finished') as
      | { result?: { kind?: string } }
      | undefined;
    expect(finished?.result?.kind).toBe('cancelled');
  } finally {
    await provider.close();
  }
});
