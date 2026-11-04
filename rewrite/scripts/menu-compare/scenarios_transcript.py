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
