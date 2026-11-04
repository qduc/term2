"""Composer, key bindings, footer hints, command results, steering/queue and history (soak items 4-5, 12,
26-28, 38, 43-49, 58, 60-62, 66, 69-72, 75, 77). Command output prints above the divider: compare with FULL=1."""

_TURN = {'replies': [{'text': 'First answer.'}, {'text': 'Second answer.'}]}
_STREAM = {'replies': [{'text': 'PARTIAL-REPLY', 'hold': 25}, {'text': 'AFTER-REPLY'}, {'text': 'THIRD-REPLY'}]}

SCENARIOS = {
    # footer hints (4-5)
    'draft-footer': ['hello there'],
    'draft-footer-clear': ['hello', '<bs><bs><bs><bs><bs>'],
    # shell mode (60)
    'bang': ['!'],
    'bang-text': ['!ls'],
    'bang-bs': ['!', '<bs>'],
    # Alt+Enter idle (61)
    'alt-enter-idle': ['line one', '<a-enter>', 'line two'],
    # Escape on a draft (62)
    'esc-draft': ['some draft', '<esc>'],
    'esc-draft-twice': ['some draft', '<esc>', '<esc>'],
    'esc-empty': ['<esc>'],
    # Ctrl+C (77)
    'ctrl-c-empty': ['<c-c>'],
    'ctrl-c-draft': ['some draft', '<c-c>'],
    'ctrl-c-twice-wait': ['<c-c>', '<sleep>', '<c-c>'],
    # other keys idle
    'ctrl-t': ['<c-t>'],
    'ctrl-g': ['<c-g>'],
    'ctrl-b': ['<c-b>'],
    'stab': ['<stab>'],
    'stab-yes': ['<stab>', '<left>', '<enter>'],
    # Tab and Escape in the / menu (26, 28)
    'slash-tab-model': ['/mod', '<tab>'],
    'esc-profile-type': ['/profile', '<esc>', '/copy', '<enter>'],
    'esc-tasks': ['/tasks', '<esc>'],
    # commands (38, 43-49)
    'cmd-effort-low': ['/effort low', '<enter>'],
    'cmd-effort-ultra': ['/effort ultra', '<enter>'],
    'cmd-auto-auto': ['/auto-approve auto', '<enter>'],
    'cmd-auto-off': ['/auto-approve auto', '<enter>', '/auto-approve off', '<enter>'],
    'cmd-tasks-enter': ['/tasks', '<enter>'],
    'cmd-sandbox': ['/sandbox', '<enter>'],
    'cmd-handoff': ['hello', '<enter>', '<sleep>', '/handoff', '<enter>'],
    'cmd-handoff-esc': ['hello', '<enter>', '<sleep>', '/handoff', '<enter>', '<esc>'],
    'cmd-retry-empty': ['/retry', '<enter>'],
    'cmd-retry-turn': ['hello', '<enter>', '<sleep>', '/retry', '<enter>', '<sleep>'],
    'cmd-retry-tool': ['/retry-tool', '<enter>'],
    'cmd-retry-turn-empty': ['/retry-turn', '<enter>'],
    'cmd-clear-empty': ['/clear', '<enter>', '<sleep>'],
    'cmd-clear-turn': ['hello', '<enter>', '<sleep>', '/clear', '<enter>', '<sleep>'],
    'cmd-copy-turn': ['hello', '<enter>', '<sleep>', '/copy', '<enter>'],
    'cmd-copy-empty': ['/copy', '<enter>'],
    'cmd-rewind-empty': ['/rewind', '<enter>'],
    'cmd-undo-empty': ['/undo', '<enter>'],
    'cmd-compact-empty': ['/compact', '<enter>', '<sleep>'],
    'cmd-queue': ['/queue', '<enter>'],
    'cmd-steer': ['/steer', '<enter>'],
    'cmd-followup': ['/followup', '<enter>'],
    'cmd-cancel': ['/cancel', '<enter>'],
    'cmd-answer': ['/answer', '<enter>'],
    'cmd-exit': ['/exit', '<enter>'],
    'cmd-lite': ['/lite', '<enter>'],
    'cmd-bare': ['/bare', '<enter>'],
    'cmd-usage': ['/usage', '<enter>'],
    'cmd-goal': ['/goal', '<enter>'],
    'cmd-model-set': ['/model mock-beta', '<enter>', '<sleep>'],
    'cmd-unknown': ['/zzz', '<enter>'],
    'cmd-help-full': ['/help', '<enter>'],
    # history (58)
    'history-cmd': ['hello', '<enter>', '<sleep>', '/usage', '<enter>', '<up>'],
    'history-two': ['hello', '<enter>', '<sleep>', '/usage', '<enter>', '<up>', '<up>'],
    'history-down': ['hello', '<enter>', '<sleep>', '<up>', '<down>'],
    # streaming (66, 69-72, 75)
    'stream-footer': ['go', '<enter>', '<sleep>'],
    'stream-type': ['go', '<enter>', '<sleep>', 'steer this'],
    'stream-steer': ['go', '<enter>', '<sleep>', 'steer this', '<enter>'],
    'stream-queue': ['go', '<enter>', '<sleep>', 'queue this', '<a-enter>'],
    'stream-queue-up': ['go', '<enter>', '<sleep>', 'queue this', '<a-enter>', '<up>'],
    'stream-queue-edit': ['go', '<enter>', '<sleep>', 'queue this', '<a-enter>', '<up>', 'e'],
    'stream-esc': ['go', '<enter>', '<sleep>', '<esc>'],
    'stream-esc-twice': ['go', '<enter>', '<sleep>', '<esc>', '<esc>'],
    'stream-ctrl-c': ['go', '<enter>', '<sleep>', '<c-c>'],
    'stream-ctrl-c-draft': ['go', '<enter>', '<sleep>', 'draft', '<c-c>'],
    'stream-queue-cmd': ['go', '<enter>', '<sleep>', '/queue', '<enter>'],
    'stream-ctrl-t': ['go', '<enter>', '<sleep>', '<c-t>'],
}

SEED = {name: _TURN for name in SCENARIOS if 'turn' in name or name.startswith(('history', 'cmd-handoff'))}
SEED.update({name: _STREAM for name in SCENARIOS if name.startswith('stream')})
