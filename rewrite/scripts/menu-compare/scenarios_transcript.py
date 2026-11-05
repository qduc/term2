"""Core transcript flows: start-up header, replies, tool rows, status counters, compaction, resize, resume, exit.

Compare these with FULL=1 so the whole transcript (scrollback and screen) is compared, not only the menu region.
"""

_USAGE = {'prompt_tokens': 1200, 'completion_tokens': 80}
_MD = ('# Plan\n\nHere is **bold** text, some `inline code` and a list:\n\n- first item\n- second item with a much '
       'longer line that has to wrap once the terminal is only eighty columns wide, and keeps going a bit\n\n'
       '1. one\n2. two\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nA closing paragraph.')
_LONG = ('This reply is one long paragraph that wraps across several rows at one hundred columns and even more rows '
         'at eighty columns, so the reflow after a resize shows how each CLI continues a wrapped line.')
_SHELL = {'tool': 'shell', 'args': {'command': 'echo hi', 'description': 'Print a greeting'}}
# A write needs approval (a read-only `echo` is approved on its own); no description, as in the soak.
_TOUCH = {'tool': 'shell', 'args': {'command': 'touch created-by-walk.txt'}}
_LS = {'tool': 'shell', 'args': {'command': 'ls'}}
_ASK = {'tool': 'ask_user', 'args': {'questions': [{'question': 'Pick a colour?',
                                                   'options': [{'label': 'Amber'}, {'label': 'Violet'}]}]}}
_ECHO = {'tool': 'shell', 'args': {'command': 'echo parallel-ok'}}
_FAIL = {'tool': 'shell', 'args': {'command': 'exit 3', 'description': 'Fail on purpose'}}
# Long answers, so a short summary actually reduces the history.
_FILL = ' Filler sentence to make the history worth compacting.' * 40
_COMPACT_REPLIES = [{'text': 'Answer one.' + _FILL}, {'text': 'Answer two.' + _FILL}, {'text': 'Answer three.' + _FILL},
                    {'text': 'Summary of the conversation.'}, {'text': 'Answer four.' + _FILL},
                    {'text': 'Answer five.' + _FILL}, {'text': 'Summary again.'}]
_TURNS = ['first question', '<enter>', '<sleep>', 'second question', '<enter>', '<sleep>', 'third question', '<enter>',
          '<sleep>']

SCENARIOS = {
    't-startup': [],
    't-markdown': ['show me markdown', '<enter>', '<sleep>'],
    't-markdown-stream': ['show me markdown', '<enter>', '<sleep>', '<sleep>'],
    't-stream-long': ['write a lot', '<enter>', '<sleep>', '<sleep>', '<sleep>'],
    't-long': ['say something long', '<enter>', '<sleep>'],
    't-turns': _TURNS,
    't-stream': ['stream please', '<enter>', '<sleep>'],
    't-stream-done': ['stream please', '<enter>', '<sleep>', '<sleep>', '<sleep>', '<sleep>'],
    't-tool-auto': ['run it', '<enter>', '<sleep>', '<sleep>'],
    't-tool-ls': ['list the files', '<enter>', '<sleep>', '<sleep>'],
    't-tool-fail': ['run it', '<enter>', '<sleep>', '<sleep>'],
    't-tool-approve': ['run it', '<enter>', '<sleep>', '1', '<sleep>', '<sleep>'],
    't-tool-pending': ['run it', '<enter>', '<sleep>'],
    't-tool-deny': ['run it', '<enter>', '<sleep>', '2', '<sleep>', '<sleep>'],
    't-tool-deny-reason': ['run it', '<enter>', '<sleep>', '2', '<sleep>', 'not now', '<enter>', '<sleep>', '<sleep>'],
    't-compact': _TURNS + ['/compact', '<enter>', '<sleep>', '<sleep>', 'fourth question', '<enter>', '<sleep>',
                           'fifth question', '<enter>', '<sleep>', '/compact', '<enter>', '<sleep>', '<sleep>'],
    't-compact-unconfigured': ['first question', '<enter>', '<sleep>', '/compact', '<enter>', '<sleep>'],
    # A compacted history holding an approved tool call and its result: the estimate counts legacy's tool items.
    't-compact-tools': ['run it', '<enter>', '<sleep>', '1', '<sleep>', '<sleep>', 'second question', '<enter>', '<sleep>',
                        'third question', '<enter>', '<sleep>', '/compact', '<enter>', '<sleep>', '<sleep>'],
    't-resize-down': ['say something long', '<enter>', '<sleep>', '<resize-80x24>', '<sleep>'],
    't-resize-back': ['say something long', '<enter>', '<sleep>', '<resize-80x24>', '<sleep>', '<resize-100x34>',
                      '<sleep>'],
    't-resize-stream': ['write a lot', '<enter>', '<sleep>', '<resize-80x24>', '<sleep>', '<sleep>', '<sleep>'],
    't-resume': ['/resume ', '<sleep>', '<enter>', '<sleep>'],
    't-status-msgs': ['/usage', '<enter>', '<sleep>', '/effort', '<enter>', '<sleep>', 'hello', '<enter>', '<sleep>'],
    't-rewind': ['first question', '<enter>', '<sleep>', 'second question', '<enter>', '<sleep>', '/rewind ', '<enter>',
                 '<sleep>', '<enter>', '<sleep>', 'third question', '<enter>', '<sleep>'],
    't-resume-long': ['/resume ', '<sleep>', '<enter>', '<sleep>'],
    't-long-user': [_LONG, '<enter>', '<sleep>'],
    't-model-switch': ['first question', '<enter>', '<sleep>', '/model mock-beta', '<enter>', '<sleep>'],
    't-cancel': ['stream please', '<enter>', '<sleep>', '<esc>', '<esc>', '<sleep>'],
    # The turn still waits for its first byte: the rows between the user's message and "Waiting for model".
    't-waiting': ['go', '<enter>', '<sleep>'],
    't-waiting-multiline': ['first line', '<a-enter>', '<a-enter>', 'third line', '<enter>', '<sleep>'],
    # A question and a shell call in one reply. Bare has no ask_user, so the call fails at once and keeps its place.
    't-ask-mixed': ['ask me', '<enter>', '<sleep>', '<enter>', '<sleep>', '<sleep>'],
    # /compact before any turn, with a sizeable model: legacy's "Nothing to compact" wording.
    't-compact-empty': ['/compact', '<enter>', '<sleep>'],
    # A resumed conversation whose last request reported usage: does the status bar show its context?
    't-resume-usage': ['/resume ', '<sleep>', '<enter>', '<sleep>'],
    't-exit-fresh': ['<c-c>', '<c-c>', '<sleep>'],
    't-exit-turn': ['hello', '<enter>', '<sleep>', '<c-c>', '<c-c>', '<sleep>'],
    't-exit-cmd': ['hello', '<enter>', '<sleep>', '/exit', '<enter>', '<sleep>'],
}

SEED = {
    't-markdown': {'replies': [{'text': _MD}], 'usage': _USAGE},
    't-markdown-stream': {'replies': [{'text': _MD, 'chunks': 20, 'delay': 0.15}], 'usage': _USAGE},
    't-stream-long': {'replies': [{'text': '\n\n'.join(f'Paragraph {i} has a few words in it.' for i in range(14)),
                                   'chunks': 28, 'delay': 0.1}], 'usage': _USAGE},
    't-long': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-turns': {'replies': [{'text': 'Answer one.'}, {'text': 'Answer two.'}, {'text': 'Answer three.'}],
                'usage': _USAGE},
    't-stream': {'replies': [{'text': 'word ' * 60, 'chunks': 30, 'delay': 0.2}], 'usage': _USAGE},
    't-stream-done': {'replies': [{'text': 'word ' * 60, 'chunks': 30, 'delay': 0.2}], 'usage': _USAGE},
    't-tool-auto': {'replies': [_SHELL, {'text': 'done'}], 'usage': _USAGE,
                    'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-ls': {'replies': [_LS, {'text': 'done'}], 'usage': _USAGE,
                  'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-fail': {'replies': [_FAIL, {'text': 'done'}], 'usage': _USAGE,
                    'settings': {'shell': {'autoApproveMode': 'always'}}},
    't-tool-approve': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-pending': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-deny': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    't-tool-deny-reason': {'replies': [_TOUCH, {'text': 'done'}], 'usage': _USAGE},
    # Legacy's /compact ignores compactThresholdTokens, so an uncatalogued model needs an input ceiling to compact.
    't-compact': {'replies': _COMPACT_REPLIES, 'usage': _USAGE,
                  'settings': {'agent': {'retryAttempts': 0, 'maxRequestInputTokens': 100000,
                                         'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}}},
    't-compact-unconfigured': {'replies': _COMPACT_REPLIES, 'usage': _USAGE},
    't-compact-tools': {'replies': [_TOUCH, {'text': 'Done.' + _FILL}, {'text': 'Answer two.' + _FILL},
                                    {'text': 'Answer three.' + _FILL}, {'text': 'Summary of the conversation.'}],
                        'usage': _USAGE, 'settings': {'agent': {'retryAttempts': 0, 'maxRequestInputTokens': 100000,
                                                                'modelSelection': {'model': 'mock-alpha',
                                                                                   'provider': 'mockprov'}}}},
    't-resize-down': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-resize-back': {'replies': [{'text': _LONG}], 'usage': _USAGE},
    't-resize-stream': {'replies': [{'text': '\n\n'.join(f'Paragraph {i} has a few words in it.' for i in range(30)),
                                     'chunks': 30, 'delay': 0.25}], 'usage': _USAGE},
    't-resume': {'sessions': [['short first turn', 'second turn', 'third turn']]},
    't-rewind': {'replies': [{'text': 'Answer one.'}, {'text': 'Answer two.'}, {'text': 'Answer three.'}]},
    't-resume-long': {'sessions': [['short first turn', _LONG, 'third turn', _LONG + ' again', 'fifth turn',
                                     'sixth turn']]},
    't-long-user': {'replies': [{'text': 'Short answer.'}], 'usage': _USAGE},
    't-model-switch': {'replies': [{'text': 'Answer one.'}], 'usage': _USAGE},
    't-waiting': {'replies': [{'text': 'late', 'wait': 20}]},
    't-waiting-multiline': {'replies': [{'text': 'late', 'wait': 20}]},
    't-cancel': {'replies': [{'text': '\n\n'.join(f'sw{i}' for i in range(40)), 'chunks': 40, 'delay': 0.25}],
                 'usage': _USAGE},
    't-ask-mixed': {'replies': [{'calls': [_ASK, _ECHO]}, {'text': 'done'}], 'usage': _USAGE},
    't-compact-empty': {'settings': {'agent': {'retryAttempts': 0, 'maxRequestInputTokens': 100000,
                                               'modelSelection': {'model': 'mock-alpha', 'provider': 'mockprov'}}}},
    't-resume-usage': {'sessions': [['first turn', 'second turn']],
                       'session_usage': {'prompt_tokens': 12000, 'completion_tokens': 80}},
    't-exit-turn': {'replies': [{'text': 'Hi there.'}], 'usage': _USAGE},
    't-exit-cmd': {'replies': [{'text': 'Hi there.'}], 'usage': _USAGE},
}

# The real-terminal walk's shape: a markdown reply, then a tool turn, so the transcript overflows the screen; then
# what the walk does next (/settings closed, Ctrl+O, Shift+Tab, the exit confirmation).
_WALK = ['show markdown please', '<enter>', '<sleep>', 'list the files please', '<enter>', '<sleep>', '<sleep>']
SCENARIOS.update({
    't-walk': _WALK,
    't-walk-settings': _WALK + ['/settings', '<enter>', '<sleep>', '<down>', '<esc>', '<sleep>'],
    't-walk-ctrl-o': _WALK + ['<c-o>', '<sleep>'],
    't-walk-ctrl-o-closed': _WALK + ['<c-o>', '<sleep>', '<c-o>', '<sleep>'],
    't-walk-stab': _WALK + ['<stab>', '<sleep>'],
    't-walk-stab-back': _WALK + ['<stab>', '<sleep>', '<stab>', '<sleep>'],
    't-walk-exit': _WALK + ['<c-c>', '<sleep>'],
})
SEED.update({name: {'replies': [{'text': _MD + '\n\nThat is all.'}, _LS,
                                {'text': 'Done. The command finished; the workspace listing is above.'}],
                    'usage': _USAGE, 'settings': {'shell': {'autoApproveMode': 'always'}}}
             for name in SCENARIOS if name.startswith('t-walk')})
# The same walk, caught mid-turn: the shell call still streaming, then the turn waiting for the reply after it.
_WALK_MID = ['show markdown please', '<enter>', '<sleep>', 'list the files please', '<enter>', '<sleep>', '<sleep>']
SCENARIOS.update({'t-walk-calling': _WALK_MID, 't-walk-after-tool': _WALK_MID})
SEED['t-walk-calling'] = {'replies': [{'text': _MD + '\n\nThat is all.'}, dict(_LS, hold=20), {'text': 'Done.'}],
                          'usage': _USAGE, 'settings': {'shell': {'autoApproveMode': 'always'}}}
SEED['t-walk-after-tool'] = {'replies': [{'text': _MD + '\n\nThat is all.'}, _LS, {'text': 'Done.', 'wait': 20}],
                             'usage': _USAGE, 'settings': {'shell': {'autoApproveMode': 'always'}}}
SCENARIOS['t-walk-running'] = ['show markdown please', '<enter>', '<sleep>', 'list the files please', '<enter>', '<sleep>']
SEED['t-walk-running'] = {'replies': [{'text': _MD + '\n\nThat is all.'},
                                      {'tool': 'shell', 'args': {'command': 'sleep 20'}}, {'text': 'Done.'}],
                          'usage': _USAGE, 'settings': {'shell': {'autoApproveMode': 'always'}}}
SCENARIOS['t-walk-short-tool'] = _WALK
SEED['t-walk-short-tool'] = {'replies': [{'text': _MD + '\n\nThat is all.'},
                                         {'tool': 'shell', 'args': {'command': 'sleep 0.4; ls'}}, {'text': 'Done.'}],
                             'usage': _USAGE, 'settings': {'shell': {'autoApproveMode': 'always'}}}
# The whole real-terminal walk, step by step (rewrite/parity/real-terminal/lib/walk.mjs), up to each checked step.
_FULLWALK = {
    '03': ['show markdown please', '<enter>', '<sleep>'],
    '04': ['list the files please', '<enter>', '<sleep>', '<sleep>'],
    '06': ['create a file please', '<enter>', '<sleep>', '<enter>', '<sleep>', '<sleep>'],
    '08': ['/', '<sleep>', '<esc>', '<sleep>'],
    '10': ['@', '<sleep>', '<esc>', '<sleep>', '<bs>', '<sleep>'],
    '13': ['/model', '<enter>', '<sleep>', '<down>', '<esc>', '<sleep>'],
    '16': ['/settings', '<enter>', '<sleep>', '<down>', '<esc>', '<sleep>'],
    '17': ['<c-o>', '<sleep>'],
}
_steps = []
for _step, _keys in _FULLWALK.items():
    _steps = _steps + _keys
    SCENARIOS[f't-fullwalk-{_step}'] = list(_steps)
SCENARIOS['t-fullwalk-29'] = _steps + ['<esc>', '<sleep>', '<c-c>', '<sleep>']
SEED.update({name: {'replies': [{'text': _MD + '\n\nThat is all.'}, _LS,
                                {'text': 'Done. The command finished; the workspace listing is above.'}, _TOUCH,
                                {'text': 'Created it.'}], 'usage': _USAGE}
             for name in SCENARIOS if name.startswith('t-fullwalk')})
_HELPWALK = {
    '18': ['<c-o>', '<sleep>'],
    '20': ['<stab>', '<sleep>', '<stab>', '<sleep>'],
    '22': ['/help', '<enter>', '<sleep>', '<esc>', '<sleep>'],
    '25': ['/resume', '<enter>', '<sleep>', '<down>', '<sleep>', '<esc>', '<sleep>'],
    '28': ['<resize-80x24>', 'typed after resize', '<sleep>', '<resize-100x34>'],
    '29w': ['<bs>'] * 20 + ['<sleep>', '<c-c>', '<sleep>'],
}
for _step, _keys in _HELPWALK.items():
    _steps = _steps + _keys
    SCENARIOS[f't-fullwalk-{_step}'] = list(_steps)
SEED.update({name: {'replies': [{'text': _MD + '\n\nThat is all.'}, _LS,
                                {'text': 'Done. The command finished; the workspace listing is above.'}, _TOUCH,
                                {'text': 'Created it.'}], 'usage': _USAGE}
             for name in SCENARIOS if name.startswith('t-fullwalk')})
# The walk's /help, a resize round trip, then the exit confirmation (the walk's steps 21-29 without the resume list).
_HELP_EXIT = _WALK + ['/help', '<enter>', '<sleep>', '<esc>', '<sleep>']
SCENARIOS.update({
    't-walk-help': _HELP_EXIT,
    't-walk-help-exit': _HELP_EXIT + ['<c-c>', '<sleep>'],
    't-walk-help-resize-exit': _HELP_EXIT + ['<resize-80x24>', 'typed after resize', '<sleep>', '<resize-100x34>']
                               + ['<bs>'] * 20 + ['<sleep>', '<c-c>', '<sleep>'],
})
for _name in ('t-walk-help', 't-walk-help-exit', 't-walk-help-resize-exit'):
    SEED[_name] = SEED['t-walk']
