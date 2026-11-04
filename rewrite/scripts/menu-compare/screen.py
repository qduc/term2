#!/usr/bin/env python3
"""Drive the legacy CLI and term2-next in a pty and capture the screen with pyte.

Evidence harness for rewrite/docs/menu-port-report.md, not a test suite.

  python3 rewrite/scripts/menu-compare/screen.py run <legacy|next> <cols> <rows> <scenario>
  python3 rewrite/scripts/menu-compare/screen.py compare <cols> <rows> [scenario ...]

Each scenario is a list of key steps (scenarios.py). Both CLIs get a fresh
scratch HOME/XDG_* tree, the same settings file and a fake OpenAI-compatible
provider that only lists models. The captured screen keeps per-cell colour and
attributes; masks hide the version string, ids, paths, ports and durations.
"""
import json
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
import fcntl
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
MODELS = ['mock-alpha', 'mock-beta', 'mock-gamma', 'gpt-test-mini']


class Provider(BaseHTTPRequestHandler):
    # Scripted chat replies, one per POST in order (the last repeats): {'text': ..., 'hold': seconds?} or
    # {'tool': name, 'args': {...}}; 'hold' keeps the stream open after the text. Set from the scenario's SEED['replies'].
    replies = [{'text': 'done'}]
    posts = 0

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
        self.rfile.read(int(self.headers.get('content-length', 0)))
        reply = Provider.replies[min(Provider.posts, len(Provider.replies) - 1)]
        Provider.posts += 1
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()

        def event(delta, finish=None):
            chunk = {'id': 'r', 'object': 'chat.completion.chunk', 'model': 'mock-alpha',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(b'data: ' + json.dumps(chunk).encode() + b'\n\n')

        if 'tool' in reply:
            call = {'index': 0, 'id': f'call{Provider.posts}', 'type': 'function',
                    'function': {'name': reply['tool'], 'arguments': json.dumps(reply['args'])}}
            event({'role': 'assistant', 'tool_calls': [call]})
            event({}, 'tool_calls')
        else:
            event({'role': 'assistant', 'content': reply['text']})
            if reply.get('hold'):  # keep the turn streaming so a scenario can act mid-turn
                self.wfile.flush()
                time.sleep(reply['hold'])
            event({}, 'stop')
        self.wfile.write(b'data: [DONE]\n\n')


def start_provider():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
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
    '<c-r>': '\x12', '<c-d>': '\x04', '<c-o>': '\x0f', '<c-t>': '\x14', '<c-u>': '\x15', '<c-c>': '\x03', '<c-g>': '\x07',
}


def expand(step):
    out = []
    for part in re.split(r'(<[a-z-]+>)', step):
        out.append(KEYS.get(part, part))
    return ''.join(out)


class Term:
    def __init__(self, cli, cols, rows, env, cwd):
        self.screen = pyte.Screen(cols, rows)
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
        for chunk in re.split(r'(<[a-z-]+>)', keys):
            if not chunk:
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


MASKS = [
    (re.compile(r'127\.0\.0\.1:\d+'), '<host>:<port>'),
    (re.compile(r'v?\d+\.\d+\.\d+(-[\w.]+)?(\+[0-9a-f]+)?'), '<ver>'),
    # Session ids: legacy uses bare UUIDs, term2-next prefixes them with `conv_`.
    (re.compile(r'(conv_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'), '<id>'),
    (re.compile(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d'), '<time>'),
    (re.compile(r'\b\d+ (second|minute|hour)s? ago|\b\d+ [a-z]*…'), '<dur> ago'),
    (re.compile(r'(/tmp|/private)?/[\w.-]*menucmp[\w./-]*'), '<path>'),
    (re.compile(r'\b\d+(\.\d+)?(ms|s)\b'), '<dur>'),
]


def mask(line):
    for pattern, repl in MASKS:
        line = pattern.sub(repl, line)
    return line


def mask_row(text):
    """Mask a screen row. Session ids differ in width (term2-next prefixes `conv_`), so on any row holding
    one the padding after it is collapsed in both CLIs and the row's cell styles are not compared."""
    masked = mask(text)
    if '<id>' not in masked:
        return masked, True
    return re.sub(r'(<id>) +', r'\1 ', masked), False


def capture(screen):
    lines, styles = [], []
    for y in range(screen.lines):
        row = screen.buffer[y]
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
        styles.append(spans if comparable else 'masked-width')
    return {'lines': lines, 'styles': styles}


def run(cli, cols, rows, name):
    scenario = SCENARIOS[name]
    Provider.replies = [{'text': 'Noted.'}]  # for the earlier sessions
    Provider.posts = 0
    server = start_provider()
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
        Provider.replies = seed.get('replies', [{'text': 'done'}])
        Provider.posts = 0
        term = Term(cli, cols, rows, env, cwd)
        try:
            term.wait_for('mockprov', 45)
            term.pump(quiet=1.0, limit=10)
            for step in scenario:
                term.send(step)
                term.pump(quiet=0.6, limit=8)
            return capture(term.screen)
        finally:
            term.close()
    finally:
        server.shutdown()
        shutil.rmtree(root, ignore_errors=True)


def menu_region(cap):
    """The bottom area from the composer divider down, without trailing blank rows.

    The start-up banner above it is transcript chrome outside the menu port and differs in layout,
    which shifts absolute rows; anchoring on the divider compares what the menus draw.
    """
    lines = cap['lines']
    if os.environ.get('FULL'):  # whole screen: transcript rows above the divider matter too
        end = len(lines)
        while end > 0 and not lines[end - 1].strip():
            end -= 1
        return {'lines': lines[:end], 'styles': cap['styles'][:end]}
    start = next((i for i, line in enumerate(lines) if re.fullmatch(r'\s*─{20,}', line)), 0)
    end = len(lines)
    while end > start and not lines[end - 1].strip():
        end -= 1
    return {'lines': lines[start:end], 'styles': cap['styles'][start:end]}


def compare(cols, rows, names):
    results = {}
    for name in names:
        a = menu_region(run('legacy', cols, rows, name))
        b = menu_region(run('next', cols, rows, name))
        same_text = a['lines'] == b['lines']
        same_style = a['styles'] == b['styles']
        results[name] = {'text': same_text, 'style': same_style, 'legacy': a, 'next': b}
        status = 'identical' if same_text and same_style else ('differs(style)' if same_text else 'differs(text)')
        print(f'{cols}x{rows} {name}: {status}', flush=True)
        if os.environ.get('VERBOSE') and status != 'identical':
            for i in range(max(len(a['lines']), len(b['lines']))):
                la = a['lines'][i] if i < len(a['lines']) else '<none>'
                lb = b['lines'][i] if i < len(b['lines']) else '<none>'
                sa = a['styles'][i] if i < len(a['styles']) else None
                sb = b['styles'][i] if i < len(b['styles']) else None
                if la != lb:
                    print(f'  L{i:2}|{la}\n  N{i:2}|{lb}')
                elif sa != sb:
                    print(f'  style {i:2}|{la}\n    L {sa}\n    N {sb}')
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
        names = sys.argv[4:] or list(SCENARIOS)
        out = compare(cols, rows, names)
        dump = os.environ.get('DUMP')
        if dump:
            with open(dump, 'w') as f:
                json.dump(out, f)
