#!/usr/bin/env python3
"""Settings persistence evidence: run a settings-changing path in both CLIs, then compare what is on disk.

  python3 scripts/menu-compare/settings_persist.py [cols rows] [case ...]

Per case and CLI: a fresh scratch HOME with the seeded settings file (screen.py), one launch that runs
the case's steps and quits, the first launch's last screen with its notice row, the settings file as it is then (masked text, so key
order counts), and a second launch's `/settings` screen and status line. Prints one line per case; DUMP=<file> writes it all.
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import screen  # noqa: E402
from scenarios import SCENARIOS, SEED  # noqa: E402

_S = '/settings '
# Each case: (steps, seed). Steps of a named scenario come from scenarios*.py.
CASES = {
    'launch-only': ([], {}),
    'model-pick': (SCENARIOS['model-select'], {}),
    'model-typed': (['/model mockprov/mock-beta', '<enter>', '<sleep>'], {}),
    'effort-pick': (SCENARIOS['effort-apply'], {}),
    'effort-typed': (['/effort high', '<enter>', '<sleep>'], {}),
    'auto-approve-pick': (SCENARIOS['auto-approve-apply'], {}),
    'auto-approve-typed': (['/auto-approve auto', '<enter>', '<sleep>'], {}),
    'settings-menu-enum': (SCENARIOS['settings-apply'], {}),
    'settings-menu-number': (SCENARIOS['settings-apply-number'], {}),
    'settings-menu-reset': ([_S + 'reset ', 'ui.displayMode', '<enter>', '<sleep>'], {'settings': {'ui': {'skin': 'classic', 'displayMode': 'concise'}}}),
    'settings-typed': (['/settings shell.timeout 90000', '<enter>', '<sleep>'], {}),
    'settings-typed-restart': (['/settings ui.skin ledger', '<enter>', '<sleep>'], {}),
    'settings-typed-model': (['/settings agent.modelSelection mock-beta', '<enter>', '<sleep>'], {}),
    'settings-typed-effort': (['/settings agent.reasoningEffort high', '<enter>', '<sleep>'], {}),
    'settings-menu-model': ([_S, 'agent.modelSelection', '<enter>', '<down>', '<enter>', '<sleep>'], {}),
    'settings-menu-effort': ([_S, 'agent.reasoningEffort', '<enter>', '<down>', '<enter>', '<sleep>'], {}),
    'settings-typed-reset': (['/settings reset agent.retryAttempts', '<enter>', '<sleep>'], {}),
    'pool-save': (SCENARIOS['pool-seeded-save'], SEED.get('pool-seeded-save', {})),
    'pool-delete': (SCENARIOS['pool-seeded-delete-yes'], SEED.get('pool-seeded-delete-yes', {})),
    'favorite': (['/model ', '<stab>', '<down>', '<c-f>', '<esc>'], {}),
    'nickname': (SCENARIOS['model-nick-save'], {}),
    'provider-edit-name': (SCENARIOS['prov-edit-name'] + ['x', '<enter>', '<sleep>'], SEED.get('prov-edit-name', {})),
    'provider-delete': (SCENARIOS['prov-delete'] + ['<enter>', '<sleep>'], SEED.get('prov-delete', {})),
    'profile-pick': (['/profile ', '<down>', '<enter>', '<sleep>'], {}),
    'bare-toggle': (['/bare ', '<enter>', '<sleep>'], {}),
    'shift-tab-plan': (['<stab>', '<sleep>'], {}),
    # Legacy's first-run gate: the main provider has no credentials, so a provider and then a model are picked.
    'first-run': (['<sleep>', '<enter>', '<sleep>', '<down>', '<enter>', '<sleep>'], {'settings': {'agent': {
        'retryAttempts': 0, 'modelSelection': {'model': 'gpt-x', 'provider': 'openai'}}}}),
    'resume-other': (['/resume ', '<sleep>', '<enter>', '<sleep>'], {'sessions': [['saved question']], 'settings': {'agent': {
        'retryAttempts': 0, 'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}}}),
}


def settings_text(env, root):
    path = os.path.join(env['XDG_STATE_HOME'], 'term2-nodejs', 'settings.json')
    try:
        text = open(path).read()
    except OSError:
        return '<missing>'
    text = text.replace(root, '<root>')
    return re.sub(r'127\.0\.0\.1:\d+', '127.0.0.1:<port>', text)


def launch(cli, cols, rows, env, cwd, steps, quit=True):
    term = screen.Term(cli, cols, rows, env, cwd)
    try:
        term.wait_for('mockprov', 45)
        term.pump(quiet=1.0, limit=10)
        for step in steps:
            term.send(step)
            term.pump(quiet=0.6, limit=8)
        cap = screen.capture(term.screen)
        if quit:
            term.send('<esc>')
            term.send('<c-u>')
            term.send('/quit')
            term.pump(quiet=0.5, limit=3)
            term.send('<enter>')
            term.pump(quiet=1.5, limit=10)
        return cap
    finally:
        term.close()


def run(cli, cols, rows, name):
    steps, seed = CASES[name]
    screen.Provider.replies = [{'text': 'Noted.'}]
    screen.Provider.posts = 0
    server = screen.start_provider()
    root = tempfile.mkdtemp(prefix='menucmp-')
    try:
        env, cwd = screen.scratch_env(root, f'http://127.0.0.1:{server.server_address[1]}/v1', seed)
        for prompts in seed.get('sessions', []):
            launch(cli, cols, rows, env, cwd, [x for p in prompts for x in (p, '<enter>', '<sleep>')])
            time.sleep(0.5)
        before = settings_text(env, root)
        first = launch(cli, cols, rows, env, cwd, steps)
        after = settings_text(env, root)
        second = launch(cli, cols, rows, env, cwd, ['/settings '])
        # The menu region ends with the status line, which names the model, effort and profile.
        return {'before': before, 'after': after, 'first': screen.menu_region(first, True),
                'second': screen.menu_region(second)}
    finally:
        server.shutdown()
        shutil.rmtree(root, ignore_errors=True)


def main():
    args = sys.argv[1:]
    cols, rows = (int(args[0]), int(args[1])) if len(args) >= 2 and args[0].isdigit() else (100, 34)
    names = [a for a in args if not a.isdigit()] or list(CASES)
    out = {}
    for name in names:
        a, b = run('legacy', cols, rows, name), run('next', cols, rows, name)
        same_file = a['after'] == b['after']
        same_second = a['second'] == b['second']
        same_first = a['first'] == b['first']
        changed = a['after'] != a['before']
        out[name] = {'legacy': a, 'next': b}
        print(f'{name}: legacy {"writes" if changed else "no write"}; file {"same" if same_file else "DIFFERS"};'
              f' second launch {"same" if same_second else "DIFFERS"}; first screen {"same" if same_first else "DIFFERS"}',
              flush=True)
        if os.environ.get('VERBOSE') and not same_file:
            import difflib
            for line in difflib.unified_diff(a['after'].splitlines(), b['after'].splitlines(), 'legacy', 'next',
                                             lineterm='', n=1):
                print('   ', line)
        for label, same in (('second', same_second), ('first', same_first)):
            if os.environ.get('VERBOSE') and not same:
                for i, (la, lb) in enumerate(zip(a[label]['lines'], b[label]['lines'])):
                    if la != lb:
                        print(f'    {label} L{i}|{la}\n    {label} N{i}|{lb}')
                if a[label]['lines'] == b[label]['lines']:
                    print(f'    {label}: same text, styles differ')
    if os.environ.get('DUMP'):
        with open(os.environ['DUMP'], 'w') as f:
            json.dump(out, f)


if __name__ == '__main__':
    main()
