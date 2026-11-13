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
    expect(launch.interpretation).toMatch(/^Ran as role "explorer" with task; agent_spec was not used/);
    const childTask = userText(children[0]!.body);
    expect(childTask).toContain('Find where parseInvoice is defined');
    expect(childTask).toContain('Done when: The defining file is reported with a line number.');
    // The role preset ran: its own tools (web and shell), not the spec's three-tool list.
    const childTools = children[0]!.body.tools!.map((tool) => tool.function.name);
    expect(childTools).toEqual(expect.arrayContaining(['shell', 'web_search', 'grep']));
    expect(userText(roots[2]!.body)).toContain('Child evidence: parseInvoice is in src/a.js:2');
  } finally {
    await provider.close();
  }
});

it('rejects a role call whose agent_spec asks for tools the role lacks, naming the shape to send', async () => {
  const provider = await startProvider((entry, rootIndex) => {
    if (!entry.root) return text('unexpected child');
    if (rootIndex === 1)
      return calls({
        name: 'run_subagent',
        args: { execution: 'background', role: 'explorer', agent_spec: { goal: 'Edit a.js', tools: ['apply_patch'] } },
      });
    return text('Stopped.');
  });
  try {
    const result = await runCli(['Edit a.js']);
    expect(result.status, result.stderr).toBe(0);
    expect(provider.seen.filter((s) => !s.root)).toHaveLength(0);
    const rejection = toolResults(provider.seen.filter((s) => s.root)[1]!.body)[0]!;
    expect(rejection).toContain('Send role+task without agent_spec, or agent_spec alone');
    expect(rejection).toContain('apply_patch, which explorer lacks');
    expect(runSubagentCalls(provider.seen)).toBe(1);
  } finally {
    await provider.close();
  }
});
