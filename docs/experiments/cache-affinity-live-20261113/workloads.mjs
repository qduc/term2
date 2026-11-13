/* global process, AbortController, Headers */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const agents = `Use the node-contracts skill for these Node.js library and CLI tasks.
Preserve public exports and all existing tests, instructions and skills. Use the
available tools normally; do not replace checks with claims. Use only Node built-ins
and edit source files under src/. No network or package installation is needed.
Run the public tests and any focused checks you need. Do not hardcode fixture values.
`;
const skill = `---
name: node-contracts
description: Implement and validate Node.js data-contract libraries and CLIs with exact input semantics.
---
Read the task's contract before editing. Distinguish missing values from falsy values.
Do not mutate caller inputs. Preserve named exports. A null AbortSignal.reason
is present and must be propagated. Validate integers without
coercion. Keep CLI stdout machine-readable, diagnostics on stderr, and propagate
nonzero exit status. Exercise normal, boundary and failure behavior with built-ins.
`;

export const WORKLOADS = {
  pagination: {
    files: {
      'src/pages.mjs': `export async function collectPages(fetchPage, options = {}) {
  let cursor = options.cursor; const items = [];
  do { const page = await fetchPage({ cursor, signal: options.signal }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return items;
}\n`,
      'src/cli.mjs': `import fs from 'node:fs';
import { collectPages } from './pages.mjs';
const pages = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(await collectPages(async ({cursor}) => pages.find(p => p.cursor === (cursor ?? null)))));\n`,
      'test/public.test.mjs': `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { collectPages } from '../src/pages.mjs';
test('collects a terminal page', async () => { assert.deepEqual(await collectPages(async () => ({items:[1], nextCursor:null})), [1]); });
test('keeps an empty-string cursor', async () => { let n=0; assert.deepEqual(await collectPages(async () => ++n===1 ? {items:[1],nextCursor:''}:{items:[2]}),[1,2]); });\n`,
    },
    request: `Repair the paginated-data library and its CLI. Keep collectPages(fetchPage, options) exported from src/pages.mjs.
fetchPage receives {cursor, signal}. Preserve order and collect every items array, including empty pages; only null/undefined nextCursor ends pagination. Empty string and numeric zero are valid cursors; distinguish numbers from strings. Cursors must be strings or finite numbers (null/undefined means terminal); malformed pages/items/cursors throw TypeError. Validate fetchPage is a function and maxPages is a positive integer, default 100, before fetching. If another page would exceed maxPages, throw RangeError before that fetch. Detect a repeated cursor and reject before fetching it twice (Error is sufficient), including when it repeats the starting cursor. Never mutate pages/options/items.
An already-aborted signal must prevent fetching. Check again after fetchPage returns, even if it ignored the signal. Throw signal.reason when present, otherwise an AbortError.
CLI: node src/cli.mjs pages.json reads an array of pages keyed by cursor, with null denoting the initial undefined cursor; output one JSON array line. On read/parse/collection errors, print a diagnostic only on stderr and exit 1. Fix src/ only. Use the node-contracts skill and run node --test test/public.test.mjs.`,
  },
  classifier: {
    files: {
      'src/errors.mjs': `export function classifyApiError(error, {nowMs = Date.now()} = {}) { const s=error?.status; return {kind:s===429?'rate_limit':'unknown',retryable:s===429}; }\n`,
      'src/retry.mjs': `import {classifyApiError} from './errors.mjs';
export async function withRetry(operation, {maxAttempts=3, sleep=async()=>{}, now=Date.now, signal}={}) { for(let n=0;;n++){try{return await operation();}catch(e){if(n>=maxAttempts||!classifyApiError(e,{nowMs:now()}).retryable)throw e;await sleep(0,signal);}} }\n`,
      'test/public.test.mjs': `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {classifyApiError} from '../src/errors.mjs'; import {withRetry} from '../src/retry.mjs';
test('quota is not a transient rate limit',()=>assert.deepEqual(classifyApiError({status:429,error:{code:'insufficient_quota'}}),{kind:'quota',retryable:false}));
test('one retry succeeds',async()=>{let n=0;assert.equal(await withRetry(async()=>{if(++n===1)throw {status:503};return 7}),7);assert.equal(n,2)});\n`,
    },
    request: `Repair src/errors.mjs and src/retry.mjs, preserving classifyApiError(error,{nowMs=Date.now()}={}) and withRetry(operation,options={}) exports.
Classifier returns {kind,retryable} plus retryAfterMs only when a valid hint exists. Structured HTTP status priority is top-level status, response.status, error.status, statusCode, then numeric code. Accept integer statuses or numeric strings in 100..599; otherwise, a string error/message prefix such as '429: ...' or 'HTTP 402 ...' supplies status. Quota has highest priority: status 402 or top-level/nested error.code equal to insufficient_quota, billing_hard_limit_reached or billing_not_active => quota,false. Next: 401/403=>authentication,false; 429=>rate_limit,true; 408/409/500..599=>transient,true; 400/404/413/422=>invalid_request,false. Otherwise ECONNRESET,ETIMEDOUT,EAI_AGAIN codes => transient,true; remaining => unknown,false. Do not infer quota from a vague message alone or let network codes override structured auth failures.
Read headers from top-level headers, falling back to response.headers. Support Headers and case-insensitive plain objects. Nonnegative finite retry-after-ms takes precedence; otherwise retry-after accepts nonnegative decimal seconds or an HTTP date relative to nowMs, clamped at zero. Invalid hints are omitted. A valid delay over 60000ms makes a rate_limit/transient error nonretryable but preserves its kind and delay.
withRetry calls operation at most maxAttempts times (default 3; require positive integer, operation function). Return success, or rethrow the original last error by identity when nonretryable/exhausted. Before another attempt await sleep(delayMs,signal), defaulting to an abort-aware real delay; use classifier delay or 0. now is a clock callback. Honor signal before first attempt and after a backoff even if injected sleep ignores it; throw signal.reason (or AbortError). Do not mutate errors/options. Fix src/ only. Use node-contracts and run node --test test/public.test.mjs.`,
  },
  jsonl: {
    files: {
      'src/summary.mjs': `export async function summarizeEvents(lines) { const accounts=new Map(); for await(const line of lines){const e=JSON.parse(line);const a=accounts.get(e.account)||{account:e.account,netCents:0,count:0};a.netCents+=e.amountCents;a.count++;accounts.set(e.account,a);}return {accounts:[...accounts.values()],invalidLines:0,duplicateEvents:0}; }\n`,
      'src/cli.mjs': `import fs from 'node:fs';import {summarizeEvents} from './summary.mjs';console.log(JSON.stringify(await summarizeEvents(fs.readFileSync(process.argv[2],'utf8').trim().split('\n'))));\n`,
      'test/public.test.mjs': `import {test} from 'node:test';import assert from 'node:assert/strict';import {summarizeEvents} from '../src/summary.mjs';
test('latest correction wins across accounts',async()=>assert.deepEqual(await summarizeEvents(['{"id":"a","account":"X","amountCents":5,"revision":0}','{"id":"a","account":"Y","amountCents":8,"revision":1}']),{accounts:[{account:'Y',netCents:8,count:1}],invalidLines:0,duplicateEvents:1}));
test('blank and malformed input',async()=>assert.deepEqual(await summarizeEvents(['','bad']),{accounts:[],invalidLines:1,duplicateEvents:0}));\n`,
    },
    request: `Repair the streaming JSONL event report in src/summary.mjs and src/cli.mjs. Preserve async summarizeEvents(lines), accepting either Iterable<string> or AsyncIterable<string>.
Each nonblank line must parse as a non-array object with nonempty string id/account, safe-integer amountCents (negative/zero allowed), and nonnegative integer revision. Whitespace-only id/account is invalid, but preserve surrounding whitespace of other nonempty values. Ignore blank lines; count each invalid JSON/schema line in invalidLines and continue. Unknown fields are ignored. Choose one event per id globally: highest revision wins; same revision uses the last valid line. Every valid repeated id increments duplicateEvents even if its revision loses. Corrections may move an event to another account. Aggregate only winning events into {account,netCents,count}; count is winning-event count. Reject unsafe-integer aggregate sums with RangeError. Sort accounts lexicographically by JS string/code-unit order. Return exactly {accounts,invalidLines,duplicateEvents} without mutating input values.
CLI: node src/cli.mjs file1.jsonl file2.jsonl ... consumes files in argument order using streams, not whole-file readFile. '-' denotes stdin and may appear at most once. Require at least one argument. Print one JSON report line; exit 0 for clean input, 2 if invalidLines>0. On I/O, invalid arguments, or overflow errors print a diagnostic only on stderr and exit 1 without a report. Fix src/ only. Use node-contracts and run node --test test/public.test.mjs.`,
  },
};

export function prepareWorkload(name, directory) {
  const task = WORKLOADS[name];
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    ...task.files,
    'AGENTS.md': agents,
    '.agents/skills/node-contracts/SKILL.md': skill,
    'package.json':
      JSON.stringify(
        { private: true, type: 'module', scripts: { test: 'node --test test/public.test.mjs' } },
        null,
        2,
      ) + '\n',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  return { prompt: task.request, files };
}

export async function gradeWorkload(name, directory) {
  const checks = [];
  const check = async (label, fn) => {
    try {
      await fn();
      checks.push({ label, pass: true });
    } catch (e) {
      checks.push({ label, pass: false, error: String(e.message) });
    }
  };
  const load = async (file) =>
    import(`${pathToFileURL(path.join(directory, file)).href}?grade=${Date.now()}-${Math.random()}`);
  const cli = (args, input) =>
    spawnSync(process.execPath, [path.join(directory, 'src/cli.mjs'), ...args], {
      cwd: directory,
      input,
      encoding: 'utf8',
      timeout: 5000,
    });
  if (name === 'pagination') {
    let collectPages;
    await check('module-export', async () => {
      ({ collectPages } = await load('src/pages.mjs'));
      assert.equal(typeof collectPages, 'function');
    });
    await check('falsy-cursors-empty-pages-order', async () => {
      const seen = [];
      const pages = [
        { items: [1], nextCursor: '' },
        { items: [], nextCursor: 0 },
        { items: [2, 3], nextCursor: null },
      ];
      assert.deepEqual(
        await collectPages(async ({ cursor }) => {
          seen.push(cursor);
          return pages[seen.length - 1];
        }),
        [1, 2, 3],
      );
      assert.deepEqual(seen, [undefined, '', 0]);
    });
    await check('typed-cursors-distinct', async () => {
      let n = 0;
      assert.deepEqual(
        await collectPages(async () => ({ items: [n], nextCursor: ++n === 1 ? 0 : n === 2 ? '0' : null })),
        [0, 1, 2],
      );
    });
    await check('cycle-before-refetch', async () => {
      let n = 0;
      await assert.rejects(() =>
        collectPages(
          async () => {
            n++;
            return { items: [], nextCursor: 'a' };
          },
          { cursor: 'a' },
        ),
      );
      assert.equal(n, 1);
    });
    await check('max-pages-before-extra-fetch', async () => {
      let n = 0;
      await assert.rejects(
        () =>
          collectPages(
            async () => {
              n++;
              return { items: [], nextCursor: n };
            },
            { maxPages: 2 },
          ),
        RangeError,
      );
      assert.equal(n, 2);
    });
    await check('invalid-options-no-fetch', async () => {
      for (const maxPages of [null, 0, -1, 1.5, '2', NaN]) {
        let n = 0;
        await assert.rejects(() =>
          collectPages(
            async () => {
              n++;
              return { items: [] };
            },
            { maxPages },
          ),
        );
        assert.equal(n, 0);
      }
      await assert.rejects(() => collectPages(null), TypeError);
    });
    await check('malformed-pages', async () => {
      for (const page of [
        null,
        {},
        { items: 'x' },
        { items: [], nextCursor: {} },
        { items: [], nextCursor: Infinity },
        { items: [], nextCursor: false },
      ])
        await assert.rejects(() => collectPages(async () => page), TypeError);
    });
    await check('abort-before-fetch', async () => {
      const a = new AbortController();
      const reason = new Error('stop');
      a.abort(reason);
      let n = 0;
      await assert.rejects(
        () =>
          collectPages(
            async () => {
              n++;
            },
            { signal: a.signal },
          ),
        (e) => e === reason,
      );
      assert.equal(n, 0);
    });
    await check('abort-after-fetch', async () => {
      const a = new AbortController();
      const reason = new Error('stop');
      await assert.rejects(
        () =>
          collectPages(
            async ({ signal }) => {
              assert.equal(signal, a.signal);
              a.abort(reason);
              return { items: [1] };
            },
            { signal: a.signal },
          ),
        (e) => e === reason,
      );
    });
    await check('does-not-mutate', async () => {
      const page = Object.freeze({ items: Object.freeze([1]), nextCursor: null });
      assert.deepEqual(await collectPages(async () => page, Object.freeze({ maxPages: 1 })), [1]);
    });
    await check('default-page-limit-is-100', async () => {
      let n = 0;
      await assert.rejects(() => collectPages(async () => ({ items: [], nextCursor: ++n })), RangeError);
      assert.equal(n, 100);
    });
    await check('null-abort-reason', async () => {
      const c = new AbortController();
      c.abort(null);
      await assert.rejects(
        () => collectPages(async () => ({ items: [] }), { signal: c.signal }),
        (e) => e === null,
      );
    });
    await check('cli-valid', async () => {
      const file = path.join(directory, 'grade-pages.json');
      fs.writeFileSync(
        file,
        JSON.stringify([
          { cursor: null, items: [1], nextCursor: '' },
          { cursor: '', items: [2] },
        ]),
      );
      const r = cli([file]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), [1, 2]);
      fs.unlinkSync(file);
    });
    await check('cli-error-clean-stdout', async () => {
      const r = cli(['missing-file.json']);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.trim());
    });
  } else if (name === 'classifier') {
    let classifyApiError, withRetry;
    await check('module-exports', async () => {
      ({ classifyApiError } = await load('src/errors.mjs'));
      ({ withRetry } = await load('src/retry.mjs'));
      assert.equal(typeof classifyApiError, 'function');
      assert.equal(typeof withRetry, 'function');
    });
    const mappings = [
      [402, 'quota', false],
      [401, 'authentication', false],
      [403, 'authentication', false],
      [429, 'rate_limit', true],
      [408, 'transient', true],
      [409, 'transient', true],
      [500, 'transient', true],
      [599, 'transient', true],
      [400, 'invalid_request', false],
      [404, 'invalid_request', false],
      [413, 'invalid_request', false],
      [422, 'invalid_request', false],
    ];
    for (const [status, kind, retryable] of mappings)
      await check(`http-${status}`, () => assert.deepEqual(classifyApiError({ status }), { kind, retryable }));
    await check('nested-quota-codes', () => {
      for (const code of ['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'])
        assert.deepEqual(classifyApiError({ status: 429, error: { code } }), { kind: 'quota', retryable: false });
    });
    await check('status-shapes-priority', () => {
      for (const e of [
        { response: { status: '429' } },
        { error: { status: 429 } },
        { statusCode: '429' },
        { code: 429 },
        'HTTP 429 retry',
        { message: '429: retry' },
      ])
        assert.equal(classifyApiError(e).kind, 'rate_limit');
      assert.equal(
        classifyApiError({ status: 401, response: { status: 429 }, code: 'ECONNRESET' }).kind,
        'authentication',
      );
    });
    await check('numeric-prefix-quota', () =>
      assert.deepEqual(classifyApiError('402 billing required'), { kind: 'quota', retryable: false }),
    );
    await check('vague-message-and-unknown', () => {
      assert.equal(classifyApiError({ status: 429, message: 'check quota later' }).kind, 'rate_limit');
      for (const e of [null, {}, 'oops', { status: 999 }])
        assert.deepEqual(classifyApiError(e), { kind: 'unknown', retryable: false });
    });
    await check('network-codes', () => {
      for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])
        assert.deepEqual(classifyApiError({ code }), { kind: 'transient', retryable: true });
    });
    await check('header-seconds-ms-precedence', () => {
      assert.equal(classifyApiError({ status: 429, headers: { 'Retry-After': '1.25' } }).retryAfterMs, 1250);
      assert.equal(
        classifyApiError({
          status: 503,
          response: { headers: new Headers({ 'retry-after-ms': '12', 'retry-after': '8' }) },
        }).retryAfterMs,
        12,
      );
    });
    await check('header-date-and-invalid', () => {
      const now = Date.parse('2026-01-01T00:00:00Z');
      assert.equal(
        classifyApiError({ status: 429, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:02 GMT' } }, { nowMs: now })
          .retryAfterMs,
        2000,
      );
      for (const value of ['garbage', '-1', 'Infinity'])
        assert.ok(
          !('retryAfterMs' in classifyApiError({ status: 429, headers: { 'retry-after': value } }, { nowMs: now })),
        );
    });
    await check('long-delay-refuses', () =>
      assert.deepEqual(classifyApiError({ status: 503, headers: { 'retry-after': '61' } }), {
        kind: 'transient',
        retryable: false,
        retryAfterMs: 61000,
      }),
    );
    await check('retry-success-and-delay', async () => {
      let n = 0;
      const waits = [];
      assert.equal(
        await withRetry(
          async () => {
            if (++n < 3) throw { status: 429, headers: { 'retry-after-ms': '7' } };
            return 9;
          },
          { sleep: async (d) => waits.push(d) },
        ),
        9,
      );
      assert.deepEqual(waits, [7, 7]);
    });
    await check('exhaustion-exact-identity', async () => {
      let n = 0;
      const e = { status: 503 };
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              n++;
              throw e;
            },
            { maxAttempts: 2, sleep: async () => {} },
          ),
        (x) => x === e,
      );
      assert.equal(n, 2);
    });
    await check('quota-no-retry', async () => {
      let n = 0;
      const e = { status: 429, error: { code: 'insufficient_quota' } };
      await assert.rejects(
        () =>
          withRetry(async () => {
            n++;
            throw e;
          }),
        (x) => x === e,
      );
      assert.equal(n, 1);
    });
    await check('retry-validation', async () => {
      for (const maxAttempts of [0, -1, 1.5, '2'])
        await assert.rejects(() => withRetry(async () => 1, { maxAttempts }));
      await assert.rejects(() => withRetry(null), TypeError);
    });
    await check('abort-boundaries', async () => {
      const a = new AbortController();
      const e = new Error('stop');
      a.abort(e);
      let n = 0;
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              n++;
            },
            { signal: a.signal },
          ),
        (x) => x === e,
      );
      assert.equal(n, 0);
      const b = new AbortController();
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              throw { status: 503 };
            },
            { signal: b.signal, sleep: async () => b.abort(e) },
          ),
        (x) => x === e,
      );
    });
  } else {
    let summarizeEvents;
    await check('module-export', async () => {
      ({ summarizeEvents } = await load('src/summary.mjs'));
      assert.equal(typeof summarizeEvents, 'function');
    });
    const line = (id, account, amountCents, revision = 0) => JSON.stringify({ id, account, amountCents, revision });
    await check('empty-input', async () =>
      assert.deepEqual(await summarizeEvents([]), { accounts: [], invalidLines: 0, duplicateEvents: 0 }),
    );
    await check('cross-account-corrections', async () =>
      assert.deepEqual(
        await summarizeEvents([line('a', 'Z', 1), line('b', 'Z', -5), line('a', 'A', 9, 2), line('a', 'X', 99, 1)]),
        {
          accounts: [
            { account: 'A', netCents: 9, count: 1 },
            { account: 'Z', netCents: -5, count: 1 },
          ],
          invalidLines: 0,
          duplicateEvents: 2,
        },
      ),
    );
    await check('tie-last-wins', async () =>
      assert.deepEqual(await summarizeEvents([line('a', 'X', 1), line('a', 'Y', 2)]), {
        accounts: [{ account: 'Y', netCents: 2, count: 1 }],
        invalidLines: 0,
        duplicateEvents: 1,
      }),
    );
    await check('invalid-schema-lines', async () => {
      const bad = [
        'bad',
        'null',
        '[]',
        '{}',
        line('', 'A', 1),
        line('a', ' ', 1),
        line('a', 'A', 1.1),
        line('a', 'A', 1, -1),
        line('a', 'A', 1, 0.5),
        JSON.stringify({ id: 'a', account: 'A', amountCents: '2', revision: 0 }),
      ];
      assert.deepEqual(await summarizeEvents(['', '  ', ...bad, line('ok', 'A', 0)]), {
        accounts: [{ account: 'A', netCents: 0, count: 1 }],
        invalidLines: bad.length,
        duplicateEvents: 0,
      });
    });
    await check('code-unit-sort-and-spaces', async () => {
      const r = await summarizeEvents([line('a', 'a', 1), line('b', 'Z', 2), line('c', ' A ', 3)]);
      assert.deepEqual(
        r.accounts.map((a) => a.account),
        [' A ', 'Z', 'a'],
      );
    });
    await check('async-stream', async () => {
      async function* rows() {
        for (let n = 0; n < 500; n++) yield line(String(n), n % 2 ? 'B' : 'A', n);
      }
      const r = await summarizeEvents(rows());
      assert.deepEqual(r.accounts, [
        { account: 'A', netCents: 62250, count: 250 },
        { account: 'B', netCents: 62500, count: 250 },
      ]);
    });
    await check('source-iterator-failure', async () => {
      const error = new Error('source failed');
      async function* rows() {
        yield line('x', 'A', 1);
        throw error;
      }
      await assert.rejects(
        () => summarizeEvents(rows()),
        (e) => e === error,
      );
    });
    await check('overflow-rejects', async () =>
      assert.rejects(() => summarizeEvents([line('a', 'A', Number.MAX_SAFE_INTEGER), line('b', 'A', 1)]), RangeError),
    );
    await check('cli-files-and-invalid-exit', () => {
      const a = path.join(directory, 'grade-a.jsonl'),
        b = path.join(directory, 'grade-b.jsonl');
      fs.writeFileSync(a, line('a', 'Z', 1) + '\ninvalid\n');
      fs.writeFileSync(b, line('a', 'A', 2, 1) + '\n');
      const r = cli([a, b]);
      assert.equal(r.status, 2, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        accounts: [{ account: 'A', netCents: 2, count: 1 }],
        invalidLines: 1,
        duplicateEvents: 1,
      });
      fs.unlinkSync(a);
      fs.unlinkSync(b);
    });
    await check('cli-stdin', () => {
      const r = cli(['-'], line('x', 'A', 5) + '\n');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        accounts: [{ account: 'A', netCents: 5, count: 1 }],
        invalidLines: 0,
        duplicateEvents: 0,
      });
    });
    await check('cli-invalid-args-and-io', () => {
      for (const args of [[], ['-', '-'], ['missing.jsonl']]) {
        const r = cli(args, '');
        assert.equal(r.status, 1);
        assert.equal(r.stdout, '');
        assert.ok(r.stderr.trim());
      }
    });
    await check('cli-uses-streams', () => {
      const source = fs.readFileSync(path.join(directory, 'src/cli.mjs'), 'utf8');
      assert.ok(!/\breadFile(?:Sync)?\s*\(/.test(source), 'CLI must stream files');
    });
  }
  return {
    passed: checks.filter((c) => c.pass).length,
    total: checks.length,
    pass: checks.every((c) => c.pass),
    checks,
  };
}
