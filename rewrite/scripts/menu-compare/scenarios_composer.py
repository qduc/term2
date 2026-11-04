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

SCENARIOS.update({
    'cmd-profile-plan': ['/profile plan', '<enter>', '<sleep>'],
    'stab-twice': ['<stab>', '<sleep>', '<stab>', '<sleep>'],
    'stab-history': ['hello', '<enter>', '<sleep>', '<stab>'],
    'stab-history-yes': ['hello', '<enter>', '<sleep>', '<stab>', '<up>', '<enter>', '<sleep>'],
    'stab-history-esc': ['hello', '<enter>', '<sleep>', '<stab>', '<esc>'],
    'cmd-bare-history': ['hello', '<enter>', '<sleep>', '/bare', '<enter>'],
    'cmd-plan-profile-bare': ['<stab>', 'hello', '<enter>', '<sleep>', '/profile bare', '<enter>'],
    'cmd-plan-profile-bare-yes': ['<stab>', 'hello', '<enter>', '<sleep>', '/profile bare', '<enter>', '<up>', '<enter>', '<sleep>'],
    'cmd-plan-profile-bare-esc': ['<stab>', 'hello', '<enter>', '<sleep>', '/profile bare', '<enter>', '<esc>'],
})
SEED.update({name: _TURN for name in ('stab-history', 'stab-history-yes', 'stab-history-esc', 'cmd-bare-history',
    'cmd-plan-profile-bare', 'cmd-plan-profile-bare-yes', 'cmd-plan-profile-bare-esc')})

SCENARIOS.update({
    'bang-run': ['!pwd', '<enter>', '<sleep>'],
    'bang-esc': ['!', '<esc>'],
    'bang-blank': ['!', '<enter>'],
    'bang-up': ['hello', '<enter>', '<sleep>', '!', '<up>'],
})
SEED['bang-up'] = _TURN

_HAND = ['hello', '<enter>', '<sleep>', '/handoff', '<enter>']
_HANDOFF = {'replies': [{'text': 'First answer.'}, {'text': 'Handed-off answer.'}, {'text': 'Third.'}]}
SCENARIOS.update({
    'handoff-empty': ['/handoff', '<enter>'],
    'handoff-typed': _HAND + ['check it'],
    'handoff-enter': _HAND + ['<enter>'],
    'handoff-confirm-esc': _HAND + ['<enter>', '<esc>'],
    'handoff-no': _HAND + ['<enter>', '<down>', '<enter>', '<sleep>'],
    'handoff-yes': _HAND + ['<enter>', '<enter>', '<sleep>'],
    'handoff-yes-model': _HAND + ['<enter>', '<enter>', '<sleep>', '<enter>', '<sleep>'],
    'handoff-yes-effort': _HAND + ['<enter>', '<enter>', '<sleep>', '<enter>', '<sleep>', '<enter>', '<sleep>'],
    'handoff-yes-model-esc': _HAND + ['<enter>', '<enter>', '<sleep>', '<esc>', '<sleep>'],
})
SEED.update({name: _HANDOFF for name in SCENARIOS if name.startswith('handoff-') and name != 'handoff-empty'})

# exit output: legacy prints usage, then the resume hint when there was a conversation (printUsageOnce)
SCENARIOS.update({
    'exit-empty': ['/quit', '<enter>', '<sleep>', '<enter>', '<sleep>'],
    'exit-turn': ['hello', '<enter>', '<sleep>', '/quit', '<enter>', '<sleep>', '<enter>', '<sleep>'],
    'clear-twice-usage': ['hello', '<enter>', '<sleep>', '/clear', '<enter>', '<sleep>', '/usage', '<enter>'],
})
SEED.update({'exit-turn': _TURN, 'clear-twice-usage': _TURN})

# queued-message edit (queued-message-updated notice) and back-to-back queue keys (fast-queue-keys)
_QUEUE3 = ['go', '<enter>', '<sleep>', 'FOLLOWUP-ONE', '<a-enter>', 'STEER-ONE', '<enter>', 'STEER-TWO', '<enter>']
SCENARIOS.update({
    'stream-queue-edit-save': ['go', '<enter>', '<sleep>', 'queue this', '<a-enter>', '<up>', 'e', ' more', '<enter>'],
    'stream-queue-burst': _QUEUE3 + ['<burst><up><up><up>e'],
    'stream-queue-spaced': _QUEUE3 + ['<up>', '<up>', '<up>', 'e'],
})
SEED.update({name: _STREAM for name in ('stream-queue-edit-save', 'stream-queue-burst', 'stream-queue-spaced')})
# item 75: /queue + Enter while the queue is paused by an interrupt
SCENARIOS['stream-queue-paused'] = ['go', '<enter>', '<sleep>', 'queue this', '<a-enter>', '<esc>', '<esc>', '<sleep>',
                                    '/queue', '<enter>', '<sleep>']
SEED['stream-queue-paused'] = _STREAM
# /undo last after a turn: the alias line and the rewind (legacy rewind truncation)
SCENARIOS['cmd-undo-last'] = ['hello', '<enter>', '<sleep>', '/undo last', '<enter>', '<sleep>']
SEED['cmd-undo-last'] = _TURN

# handoff-yes-effort with the handed-off turn still waiting for the model under the effort menu
SCENARIOS['handoff-yes-effort-waiting'] = SCENARIOS['handoff-yes-effort']
SEED['handoff-yes-effort-waiting'] = {
    'replies': [{'text': 'First answer.'}, {'text': 'Handed-off answer.', 'wait': 20}, {'text': 'Third.'}]
}
