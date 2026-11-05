#!/usr/bin/env python3
"""Drive the legacy CLI and term2-next in a pty and capture the screen with pyte.

Evidence harness for rewrite/docs/menu-port-report.md, not a test suite.

  python3 rewrite/scripts/menu-compare/screen.py run <legacy|next> <cols> <rows> <scenario>
  python3 rewrite/scripts/menu-compare/screen.py compare <cols> <rows> [scenario ...]

Captures are cached under .cache/menu-compare/, keyed by the CLI's built output (dist, minus build metadata),
the lockfile, the Node version, the capture code (MODELS through run()), the scenario's own steps and seed,
the size and the FULL mode. Legacy is the
oracle and rarely rebuilds, so later compares reuse its captures; an unchanged next build reruns for free.
CACHE=0 ignores the cache; REFRESH=1 reruns and overwrites (use it to resample a capture suspected flaky).
JOBS=n runs n scenarios at once (default: the CPU count).

Each scenario is a list of key steps (scenarios.py). Both CLIs get a fresh
scratch HOME/XDG_* tree, the same settings file and a fake OpenAI-compatible
provider that only lists models. The captured screen keeps per-cell colour and
attributes; masks hide the version string, ids, paths, ports and durations.
"""
import hashlib
import json
import subprocess
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import tempfile
import termios
import difflib
import fcntl
import fnmatch
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pyte

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)
from scenarios import SCENARIOS, SEED  # noqa: E402

CLIS = {
    'legacy': os.path.join(REPO, 'dist', 'cli.js'),
    'next': os.path.join(REPO, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'),
}
# FULL=1 compares the whole transcript (scrollback and screen) instead of the menu region;
# FULL=screen compares the whole visible screen without the scrollback.
FULL = bool(os.environ.get('FULL'))
FULL_SCREEN = os.environ.get('FULL') == 'screen'
MODELS = ['mock-alpha', 'mock-beta', 'mock-gamma', 'gpt-test-mini']


class Provider(BaseHTTPRequestHandler):
    # Scripted chat replies, one per POST in order (the last repeats): {'text': ..., 'hold': seconds?} or
    # {'tool': name, 'args': {...}}; 'hold' keeps the stream open after the text. Set from the scenario's SEED['replies'].
    replies = [{'text': 'done'}]
    posts = 0
    # [{'match': text, 'replies': [...]}]: requests whose user messages contain `match` (a subagent's task) take
    # their own reply list, so a parent and a child agent do not race for one (SEED['routes']).
    routes = []
    # {'prompt_tokens': n, 'completion_tokens': n, 'cached': n?}: sent in a final usage chunk after every reply
    # (SEED['usage']); None sends no usage.
    usage = None

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({'object': 'list', 'data': [{'id': m, 'object': 'model'} for m in MODELS]}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.endswith('/chat/completions'):
            return self.do_GET()
        body = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        state = type(self)
        users = ' '.join(str(m.get('content')) for m in body.get('messages', []) if m.get('role') == 'user')
        route = next((r for r in state.routes if r['match'] in users), None)
        if route is not None:
            reply = route['replies'][min(route['posts'], len(route['replies']) - 1)]
            route['posts'] += 1
        else:
            reply = state.replies[min(state.posts, len(state.replies) - 1)]
            state.posts += 1
        if 'status' in reply:  # a failed request, e.g. {'status': 503, 'retry_after': seconds}
            failure = json.dumps({'error': {'message': 'Service unavailable', 'type': 'server_error'}}).encode()
            self.send_response(reply['status'])
            self.send_header('content-type', 'application/json')
            if 'retry_after' in reply:
                self.send_header('retry-after', str(reply['retry_after']))
            self.send_header('content-length', str(len(failure)))
            self.end_headers()
            self.wfile.write(failure)
            return
        # 'wait': seconds before the response starts, so a scenario can see the turn waiting for the model.
        time.sleep(reply.get('wait', 0))
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()

        def event(delta, finish=None):
            chunk = {'id': 'r', 'object': 'chat.completion.chunk', 'model': 'mock-alpha',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(b'data: ' + json.dumps(chunk).encode() + b'\n\n')

        if reply.get('empty'):  # a stream with no response at all
            self.wfile.write(b'data: [DONE]\n\n')
            return
        # '$RUNID' in a call's args is the last run ID the request shows (a continue_run_id).
        run_ids = re.findall(r'"runId":"([\w-]+)"', ' '.join(str(m.get('content')) for m in body.get('messages', [])))

        def arguments(c):
            text = c['raw_args'] if 'raw_args' in c else json.dumps(c['args'])
            return text.replace('$RUNID', run_ids[-1]) if run_ids else text

        if 'tool' in reply or 'calls' in reply:
            time.sleep(reply.get('delay', 0))  # lets a scenario type a draft before the approval opens
            # 'calls': several tool calls in one reply, each {'tool': name, 'args': {...}} ('raw_args': sent as is).
            calls = [{'index': i, 'id': f'call{state.posts}-{i}', 'type': 'function',
                      'function': {'name': c['tool'], 'arguments': arguments(c)}}
                     for i, c in enumerate(reply.get('calls', [reply]))]
            event({'role': 'assistant', 'tool_calls': calls})
            if reply.get('hold'):  # keep the call streaming ("Calling tool")
                self.wfile.flush()
                time.sleep(reply['hold'])
            event({}, 'tool_calls')
        else:
            # 'chunks': stream the text in that many pieces, 'delay' seconds apart (default one piece).
            text, pieces = reply['text'], max(1, reply.get('chunks', 1))
            if pieces == 1:
                time.sleep(reply.get('delay', 0))  # an open stream with no output yet
            size = -(-len(text) // pieces)
            for i in range(0, len(text), size):
                event({'role': 'assistant', 'content': text[i:i + size]} if i == 0 else {'content': text[i:i + size]})
                if pieces > 1:
                    self.wfile.flush()
                    time.sleep(reply.get('delay', 0.1))
            if reply.get('hold'):  # keep the turn streaming so a scenario can act mid-turn
                self.wfile.flush()
                time.sleep(reply['hold'])
            event({}, 'stop')
        usage = reply.get('usage', state.usage)
        if usage:
            total = {'prompt_tokens': usage['prompt_tokens'], 'completion_tokens': usage['completion_tokens'],
                     'total_tokens': usage['prompt_tokens'] + usage['completion_tokens'],
                     'prompt_tokens_details': {'cached_tokens': usage.get('cached', 0)}}
            self.wfile.write(b'data: ' + json.dumps({'id': 'r', 'object': 'chat.completion.chunk', 'model': 'mock-alpha',
                                                      'choices': [], 'usage': total}).encode() + b'\n\n')
        self.wfile.write(b'data: [DONE]\n\n')


def start_provider():
    # A handler class per server, so runs in parallel threads (JOBS) keep their own scripted replies.
    handler = type('RunProvider', (Provider,), {})
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def scratch_env(root, base_url, seed):
    home = os.path.join(root, 'home')
    workspace = os.path.join(root, 'w')
    os.makedirs(home)
    os.makedirs(workspace)
    env = {
        'PATH': os.environ['PATH'],
        'TERM': 'xterm-256color',
        'COLORTERM': 'truecolor',
        'LANG': 'C.UTF-8',
        'HOME': home,
        'XDG_CONFIG_HOME': os.path.join(home, '.config'),
        'XDG_STATE_HOME': os.path.join(home, '.local', 'state'),
        'XDG_CACHE_HOME': os.path.join(home, '.cache'),
        'XDG_DATA_HOME': os.path.join(home, '.local', 'share'),
        'XDG_RUNTIME_DIR': os.path.join(root, 'runtime'),
        'TERM2_CONFIG_DIR': os.path.join(home, '.term2'),
        'TERM2_CACHE_DIR': os.path.join(home, '.cache', 'term2'),
        'TERM2_CONVERSATIONS_DIR': os.path.join(root, 'conversations'),
        'DISABLE_LOGGING': '1',
        'CI': 'false',
        'FORCE_COLOR': '3',
        # Shared across runs (it only caches compiled bytecode, never app state): faster CLI boots.
        'NODE_COMPILE_CACHE': os.path.join(REPO, '.cache', 'menu-compare', 'node-compile-cache'),
    }
    settings_dir = os.path.join(env['XDG_STATE_HOME'], 'term2-nodejs')
    os.makedirs(settings_dir)
    settings = {
        'ui': {'skin': 'classic'},
        'agent': {'retryAttempts': 0, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}},
        'providers': [{'name': 'mockprov', 'type': 'openai-compatible', 'baseUrl': base_url, 'apiKey': 'test-key'}],
        'sandbox': {'enabled': False},
        'shell': {'autoApproveMode': 'off'},
    }
    settings.update(seed.get('settings', {}))
    # Providers appended after mockprov, e.g. one whose model listing fails.
    settings['providers'] = settings['providers'] + seed.get('extra_providers', [])
    with open(os.path.join(settings_dir, 'settings.json'), 'w') as f:
        json.dump(settings, f)
    for rel, content in seed.get('files', {}).items():
        path = os.path.join(workspace, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            f.write(content)
    return env, workspace


KEYS = {
    '<enter>': '\r', '<esc>': '\x1b', '<tab>': '\t', '<stab>': '\x1b[Z', '<up>': '\x1b[A', '<down>': '\x1b[B',
    '<right>': '\x1b[C', '<left>': '\x1b[D', '<bs>': '\x7f', '<del>': '\x1b[3~', '<pgup>': '\x1b[5~',
    '<pgdn>': '\x1b[6~', '<home>': '\x1b[H', '<end>': '\x1b[F', '<c-f>': '\x06', '<c-n>': '\x0e',
    '<c-r>': '\x12', '<c-d>': '\x04', '<c-o>': '\x0f', '<c-t>': '\x14', '<c-u>': '\x15', '<c-c>': '\x03',
    '<a-enter>': '\x1b\r', '<c-g>': '\x07', '<c-b>': '\x02', '<c-a>': '\x01', '<c-e>': '\x05', '<c-k>': '\x0b',
    '<c-w>': '\x17', '<c-l>': '\x0c', '<c-x>': '\x18', '<c-z>': '\x1a', '<c-p>': '\x10',
}


def expand(step):
    out = []
    for part in re.split(r'(<[a-z0-9-]+>)', step):
        out.append(KEYS.get(part, part))
    return ''.join(out)


class Screen(pyte.HistoryScreen):
    """A screen that keeps scrollback, and drops it on ESC[3J as a terminal does."""

    def erase_in_display(self, how=0, *args, **kwargs):
        if how == 3:
            self.history.top.clear()
        super().erase_in_display(how, *args, **kwargs)


class Term:
    def __init__(self, cli, cols, rows, env, cwd):
        self.screen = Screen(cols, rows, history=5000)
        self.stream = pyte.ByteStream(self.screen)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe('node', ['node', CLIS[cli]], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        self.raw = b''

    def pump(self, quiet=0.5, limit=15.0):
        """Read until the screen stays unchanged for `quiet` seconds."""
        start = last = time.time()
        while time.time() - start < limit:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.raw += data
                # Answer cursor-position queries so Ink does not stall.
                if b'\x1b[6n' in data:
                    os.write(self.fd, b'\x1b[1;1R')
                self.stream.feed(data)
                last = time.time()
            elif time.time() - last >= quiet:
                return

    def wait_for(self, text, limit=30.0):
        start = time.time()
        while time.time() - start < limit:
            self.pump(quiet=0.3, limit=1.0)
            if text in '\n'.join(self.screen.display):
                return True
        return False

    def send(self, keys):
        if keys.startswith('<burst>'):  # the rest in one write, as a fast typist or a paste delivers it
            os.write(self.fd, expand(keys[len('<burst>'):]).encode())
            self.pump(quiet=0.3, limit=3.0)
            return
        for chunk in re.split(r'(<[a-z0-9-]+>)', keys):
            if not chunk:
                continue
            m = re.fullmatch(r'<resize-(\d+)x(\d+)>', chunk)
            if m:
                cols, rows = int(m.group(1)), int(m.group(2))
                self.screen.resize(rows, cols)
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                os.kill(self.pid, signal.SIGWINCH)
                self.pump(quiet=1.0, limit=5.0)
                continue
            if chunk == '<sleep>':
                # Let slow asynchronous work (conversation listing, catalogues) finish before capturing.
                end = time.time() + 3.0
                while time.time() < end:
                    self.pump(quiet=3.0, limit=end - time.time())
                continue
            os.write(self.fd, expand(chunk).encode())
            time.sleep(0.15 if chunk.startswith('<') else 0.05)
            self.pump(quiet=0.15, limit=2.0)

    def close(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        # Each run opens a pty; a long compare runs out of them unless the master side is closed.
        try:
            os.close(self.fd)
        except OSError:
            pass


MASKS = [
    (re.compile(r'127\.0\.0\.1:\d+'), '<host>:<port>'),
    (re.compile(r'v?\d+\.\d+\.\d+(-[\w.]+)?(\+[0-9a-f]+)?'), '<ver>'),
    # Session ids: both CLIs show bare UUIDs (next's store prefixes `conv_`, which must not show).
    (re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'), '<id>'),
    # An id wrapped in a narrow pane (the resume menu's detail column at 80 columns): its head ends a cell and its
    # tail is the only text in the same cell on the next row.
    (re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{0,11}(?= *│)'), '<id>'),
    (re.compile(r'(?<=│  )[0-9a-f]{1,11}(?= +│)'), '<id>'),
    # Generated subagent run ids ("western-mantis-118"): random per run in both CLIs.
    (re.compile(r'\b[a-z]+-[a-z]+-\d{1,4}\b'), '<run>'),
    (re.compile(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'), '<time>'),
    (re.compile(r'\b\d+ (second|minute|hour)s? ago|\b\d+ [a-z]*…'), '<dur> ago'),
    (re.compile(r'(/tmp|/private)?/[\w.-]*menucmp[\w./-]*'), '<path>'),
    (re.compile(r'\b\d+(\.\d+)?(ms|s)\b'), '<dur>'),
    # Stream rates depend on timing; keep their format (brackets, `~`, unit), mask the number.
    (re.compile(r'\d+(\.\d+)?(?= ?(tok/s|t/s))'), '<n>'),
]


def mask(line):
    for pattern, repl in MASKS:
        line = pattern.sub(repl, line)
    return line


TIMING = re.compile(r'\b\d+(\.\d+)?(ms|s)\b|\d+(\.\d+)?(?= ?(tok/s|t/s))')


def mask_row(text):
    """Mask a screen row. Session ids differ in width (term2-next prefixes `conv_`), so on any row holding
    one the padding after it is collapsed in both CLIs and the row's cell styles are not compared. A timing
    ('9ms' against '12ms') shifts the cells after it, so styles are compared up to the first timing only;
    the second value is that column (True: the whole row)."""
    masked = mask(text)
    if '<id>' not in masked:
        timing = TIMING.search(text)
        return masked, True if timing is None else timing.start()
    return re.sub(r'(<id>) +', r'\1 ', masked), False


def capture(screen, history=False):
    """The visible screen, after the scrollback when `history` is set."""
    lines, styles = [], []
    rows = (list(screen.history.top) if history else []) + [screen.buffer[y] for y in range(screen.lines)]
    for row in rows:
        text = ''.join(row[x].data for x in range(screen.columns))
        masked, comparable = mask_row(text)
        lines.append(masked.rstrip())
        spans, prev, start = [], None, 0
        for x in range(screen.columns + 1):
            c = row[x] if x < screen.columns else None
            key = None if c is None else (c.fg, c.bg, c.bold, c.italics, c.underscore, c.reverse)
            if key != prev:
                if prev is not None and prev != ('default', 'default', False, False, False, False):
                    spans.append([start, x, *prev])
                prev, start = key, x
        if comparable is not True and comparable is not False:  # clip at the first timing
            spans = [[a, min(b, comparable), *rest] for a, b, *rest in spans if a < comparable]
        styles.append(spans if comparable is not False else 'masked-width')
    return {'lines': lines, 'styles': styles}


def run(cli, cols, rows, name):
    scenario = SCENARIOS[name]
    server = start_provider()
    provider = server.RequestHandlerClass
    provider.replies = [{'text': 'Noted.'}]  # for the earlier sessions
    provider.posts = 0
    provider.usage = SEED.get(name, {}).get('session_usage')  # usage the earlier sessions' replies report
    root = tempfile.mkdtemp(prefix='menucmp-')
    try:
        seed = SEED.get(name, {})
        env, cwd = scratch_env(root, f'http://127.0.0.1:{server.server_address[1]}/v1', seed)
        # Earlier sessions: each list of prompts is typed into its own launch, which then quits, so the
        # scenario starts with saved conversations.
        for prompts in seed.get('sessions', []):
            earlier = Term(cli, cols, rows, env, cwd)
            try:
                earlier.wait_for('mockprov', 45)
                earlier.pump(quiet=1.0, limit=10)
                for prompt in prompts:
                    earlier.send(prompt)
                    earlier.send('<enter>')
                    earlier.wait_for('Noted.', 30)
                    earlier.pump(quiet=1.0, limit=10)
                earlier.send('/quit')
                earlier.pump(quiet=0.5, limit=3)
                earlier.send('<enter>')
                earlier.pump(quiet=1.5, limit=10)
            finally:
                earlier.close()
            time.sleep(0.5)
        provider.replies = seed.get('replies', [{'text': 'done'}])
        provider.usage = seed.get('usage')
        provider.posts = 0
        provider.routes = [dict(route, posts=0) for route in seed.get('routes', [])]
        term = Term(cli, cols, rows, env, cwd)
        try:
            term.wait_for('mockprov', 45)
            term.pump(quiet=1.0, limit=10)
            for step in scenario:
                term.send(step)
                term.pump(quiet=0.6, limit=8)
            if os.environ.get('RAW'):  # RAW=<prefix>: keep the pty bytes, for tracing redraws
                with open(f"{os.environ['RAW']}-{cli}.bin", 'wb') as f:
                    f.write(term.raw)
            return capture(term.screen, history=FULL and not FULL_SCREEN)
        finally:
            term.close()
    finally:
        server.shutdown()
        shutil.rmtree(root, ignore_errors=True)


CACHE_DIR = os.path.join(REPO, '.cache', 'menu-compare')
_BUILD_KEYS = {}


# Build metadata that records the commit, not the code: hashing it would miss the cache after every commit.
BUILD_METADATA = ('build-info.json', '.term2-build-provenance.json')


def _tree_hash(root, skip=BUILD_METADATA):
    digest = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name in skip:
                continue
            path = os.path.join(dirpath, name)
            digest.update(os.path.relpath(path, root).encode() + b'\0')
            with open(path, 'rb') as f:
                digest.update(f.read())
    return digest.hexdigest()


def build_key(cli):
    """Everything outside the harness that decides what a CLI draws: its build, dependencies and Node."""
    if cli not in _BUILD_KEYS:
        dist = os.path.join(REPO, 'dist') if cli == 'legacy' else os.path.join(REPO, 'rewrite', 'dist')
        digest = hashlib.sha256()
        digest.update(cli.encode() + _tree_hash(dist).encode())
        with open(os.path.join(REPO, 'pnpm-lock.yaml'), 'rb') as f:
            digest.update(f.read())
        digest.update(subprocess.run(['node', '--version'], capture_output=True, text=True).stdout.encode())
        _BUILD_KEYS[cli] = digest.hexdigest()
    return _BUILD_KEYS[cli]


def _capture_code():
    """The harness code a capture depends on: this file from MODELS through run(). Edits to the comparison and
    reporting below, or new scenarios, keep earlier captures valid."""
    with open(os.path.abspath(__file__)) as f:
        source = f.read()
    return source[source.index('\nMODELS = '):source.index('\nCACHE_DIR = ')]


def cached_run(cli, cols, rows, name):
    """run(), reusing an earlier capture of the same build, harness, scenario, size and mode."""
    if os.environ.get('CACHE') == '0':
        return run(cli, cols, rows, name)
    mode = 'full' if FULL and not FULL_SCREEN else 'screen' if FULL_SCREEN else 'menu'
    scenario = repr((SCENARIOS[name], SEED.get(name)))
    key = hashlib.sha256(
        f'{build_key(cli)}|{_CAPTURE_CODE}|{scenario}|{cols}x{rows}|{mode}'.encode()
    ).hexdigest()
    path = os.path.join(CACHE_DIR, cli, key[:2], f'{key}.json')
    if not os.environ.get('REFRESH') and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    cap = run(cli, cols, rows, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w') as f:
        json.dump(cap, f)
    os.replace(tmp, path)
    return cap


_CAPTURE_CODE = hashlib.sha256(_capture_code().encode()).hexdigest()


def menu_region(cap, notice=False):
    """The bottom area from the composer divider down, without trailing blank rows.

    The start-up banner above it is transcript chrome outside the menu port and differs in layout,
    which shifts absolute rows; anchoring on the divider compares what the menus draw. With `notice`
    the region also takes the last non-blank row above the divider (a command's notice), without the
    blank rows between them.
    """
    lines = cap['lines']
    start = next((i for i, line in enumerate(lines) if re.fullmatch(r'\s*─{20,}', line)), 0)
    if notice:
        above = next((i for i in range(start - 1, -1, -1) if lines[i].strip()), None)
        if above is not None:
            keep = [above] + list(range(start, len(lines)))
            cap = {'lines': [lines[i] for i in keep], 'styles': [cap['styles'][i] for i in keep]}
            lines, start = cap['lines'], 0
    end = len(lines)
    while end > start and not lines[end - 1].strip():
        end -= 1
    return {'lines': lines[start:end], 'styles': cap['styles'][start:end]}


def full_region(cap):
    """Scrollback and screen (or the screen alone with FULL=screen), without trailing blank rows."""
    end = len(cap['lines'])
    while end > 0 and not cap['lines'][end - 1].strip():
        end -= 1
    return {'lines': cap['lines'][:end], 'styles': cap['styles'][:end]}


def compare(cols, rows, names):
    results = {}
    # JOBS=n runs n scenarios at once (both CLIs of a scenario run side by side as well).
    from concurrent.futures import ThreadPoolExecutor
    if os.environ.get('CACHE') != '0':
        for cli in CLIS:  # once, before the workers start: concurrent misses would each hash both trees
            build_key(cli)
    pool = ThreadPoolExecutor(max_workers=2 * max(1, int(os.environ.get('JOBS', str(os.cpu_count() or 1)))))
    futures = {name: (pool.submit(cached_run, 'legacy', cols, rows, name), pool.submit(cached_run, 'next', cols, rows, name))
               for name in names}
    for name in names:
        notice = SEED.get(name, {}).get('notice', False)
        a = full_region(futures[name][0].result()) if FULL else menu_region(futures[name][0].result(), notice)
        b = full_region(futures[name][1].result()) if FULL else menu_region(futures[name][1].result(), notice)
        same_text = a['lines'] == b['lines']
        same_style = a['styles'] == b['styles']
        results[name] = {'text': same_text, 'style': same_style, 'legacy': a, 'next': b}
        status = 'identical' if same_text and same_style else ('differs(style)' if same_text else 'differs(text)')
        print(f'{cols}x{rows} {name}: {status}', flush=True)
        if os.environ.get('VERBOSE') and status != 'identical':
            if not same_text:  # rows as a unified diff (- legacy, + next), so one extra row does not shift the rest
                for line in difflib.unified_diff(a['lines'], b['lines'], 'legacy', 'next', n=1, lineterm=''):
                    print(f'  {line}')
            matcher = difflib.SequenceMatcher(None, a['lines'], b['lines'], autojunk=False)
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                for i, j in zip(range(i1, i2), range(j1, j2)) if tag == 'equal' else []:
                    if a['styles'][i] != b['styles'][j]:
                        print(f'  style L{i}/N{j}|{a["lines"][i]}\n    L {a["styles"][i]}\n    N {b["styles"][j]}')
        sys.stdout.flush()
    return results


def show(cap):
    for i, line in enumerate(cap['lines']):
        print(f'{i:2}|{line}')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'run':
        cap = run(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
        show(cap)
        if os.environ.get('STYLES'):
            for i, s in enumerate(cap['styles']):
                if s:
                    print(i, s)
    elif cmd == 'compare':
        cols, rows = int(sys.argv[2]), int(sys.argv[3])
        # Names may be globs, e.g. 't-*' for every transcript scenario.
        names = [n for arg in sys.argv[4:] for n in (fnmatch.filter(SCENARIOS, arg) or [arg])] or list(SCENARIOS)
        out = compare(cols, rows, names)
        dump = os.environ.get('DUMP')
        if dump:
            with open(dump, 'w') as f:
                json.dump(out, f)
